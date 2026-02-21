# Data Pipeline Patterns for ML Labeling Projects

## Core Architecture

```
Raw Data Store → Pre-processing → Labeling Queue → Label Store → QA Layer → ML Export
```

Every layer should be:
- **Immutable input** — never modify raw data
- **Versioned** — all mutations timestamped
- **Attributed** — every record tied to a user/process that created it

---

## Supabase-Based Stack (Recommended for This Project)

### Tables

```sql
-- Sanitized images queue
CREATE TABLE images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_path TEXT NOT NULL,           -- Supabase Storage path
  original_filename TEXT,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  is_gold_standard BOOLEAN DEFAULT FALSE,
  gold_label JSONB,                     -- null unless gold
  status TEXT DEFAULT 'pending'         -- pending | in_progress | labeled | audited | rejected
);

-- All individual label submissions (never overwrite!)
CREATE TABLE labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  image_id UUID REFERENCES images(id),
  labeler_id UUID REFERENCES auth.users(id),
  label_data JSONB NOT NULL,            -- full label object
  time_spent_seconds INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  is_adjudicated BOOLEAN DEFAULT FALSE
);

-- Consensus / final label per image
CREATE TABLE consensus_labels (
  image_id UUID PRIMARY KEY REFERENCES images(id),
  consensus_data JSONB NOT NULL,
  method TEXT,                          -- 'majority_vote' | 'expert_adjudication' | 'single_expert'
  agreement_score FLOAT,               -- Cohen's Kappa or similar
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Labeler quality tracking
CREATE TABLE labeler_stats (
  labeler_id UUID REFERENCES auth.users(id),
  computed_at TIMESTAMPTZ DEFAULT NOW(),
  kappa_score FLOAT,
  gold_accuracy FLOAT,
  labels_count INTEGER,
  avg_time_seconds INTEGER
);
```

### Row Level Security
- Labelers can only INSERT labels, not read others' labels for the same image (prevents anchoring bias)
- Admins can read everything
- Gold standard answers are hidden from labelers (use server-side function to check accuracy)

---

## Queue Management Pattern

Assign items to labelers using a **pessimistic lock** to prevent double-labeling:

```sql
-- Claim next item for labeling
UPDATE images
SET status = 'in_progress', assigned_to = $labeler_id, assigned_at = NOW()
WHERE id = (
  SELECT id FROM images
  WHERE status = 'pending'
  AND (labeler_count < $required_labels_per_image)
  ORDER BY RANDOM()   -- or priority score
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

For **N-labeler-per-image** designs:
- Track how many labels each image has received
- Re-queue images that haven't reached N labels
- Separate gold items into the queue at a fixed rate (e.g., 1 in 10 shown to labeler)

---

## Label Versioning Pattern

Never update a label row. Instead:

```javascript
// BAD: loses history
await supabase.from('labels').update({ label_data: newLabel }).eq('id', labelId)

// GOOD: full audit trail
await supabase.from('labels').insert({
  image_id: imageId,
  labeler_id: userId,
  label_data: newLabel,
  supersedes_label_id: oldLabelId,  // foreign key to previous version
  created_at: new Date()
})
```

---

## Export for ML Training

### HuggingFace Datasets Format (JSON-Lines)
```json
{"image_path": "path/to/img.png", "label": {"type": "sensorineural", "severity": "moderate"}, "split": "train"}
{"image_path": "path/to/img2.png", "label": {"type": "conductive", "severity": "mild"}, "split": "val"}
```

### Stratified Train/Val/Test Split
```python
from sklearn.model_selection import train_test_split
import pandas as pd

df = load_consensus_labels()

# Stratify by the most important label dimension
train, temp = train_test_split(df, test_size=0.30, stratify=df['type'], random_state=42)
val, test = train_test_split(temp, test_size=0.50, stratify=temp['type'], random_state=42)

# Verify distribution
for split_name, split_df in [('train', train), ('val', val), ('test', test)]:
    print(f"{split_name}: {split_df['type'].value_counts(normalize=True).to_dict()}")
```

Recommended splits:
- **Train**: 70%
- **Val**: 15% (used during training for hyperparameter tuning)
- **Test**: 15% (held out until final evaluation — never peek!)

---

## Class Imbalance Strategies

For imbalanced audiogram datasets (e.g., many "normal", few "profound"):

1. **Oversample rare classes** — duplicate or augment
2. **Class weights** in loss function — `weight = total / (n_classes * class_count)`
3. **Stratified sampling** in DataLoader
4. **Document the imbalance** in your dataset card — do NOT silently correct it

---

## Image Augmentation for Audiograms

Augmentations safe for audiogram images:
- ✅ Small rotations (±5°) — scans are sometimes slightly tilted
- ✅ Brightness/contrast variation — simulates scan quality variance
- ✅ Gaussian noise (mild) — scan degradation simulation
- ❌ Horizontal flip — would swap left/right ears, destroying label meaning
- ❌ Aggressive cropping — may remove axis labels the model needs
- ❌ Color jitter (aggressive) — audiograms have semantic color (O=red right, X=blue left)

---

## Monitoring Data Quality Over Time

Track these metrics weekly during active labeling:
- **Label throughput** — labels per labeler per day
- **Average time per label** — sudden drops = quality risk
- **Gold standard accuracy per labeler** — drop below 80% → investigate
- **Inter-labeler κ on shared items** — should stay stable
- **Class distribution drift** — are labelers avoiding certain classes?

Build a simple admin dashboard showing these. Supabase + a React chart is sufficient.
