# Label Quality Playbook

## Why Quality Matters More Than Quantity

Fei-Fei Li's insight from ImageNet: *a small dataset with high-quality labels beats a large dataset with noisy labels*. Label noise propagates into model weights — there is no way to train your way out of it.

**Rule of thumb**: 10% label noise can degrade model accuracy by 5–15%. At 30% noise, many models fail to converge meaningfully.

---

## Cohen's Kappa (κ) — The Core Metric

Cohen's Kappa measures **agreement between two annotators beyond chance**.

```
κ = (P_observed - P_expected) / (1 - P_expected)
```

- `P_observed` = fraction of items where annotators agree
- `P_expected` = fraction of items where agreement would occur by random chance

### Interpretation
| κ Value | Interpretation |
|---------|----------------|
| < 0.00  | Less than chance — schema is actively causing confusion |
| 0.00–0.20 | Slight agreement |
| 0.21–0.40 | Fair agreement |
| 0.41–0.60 | Moderate agreement — acceptable minimum |
| 0.61–0.80 | Substantial agreement — target this |
| 0.81–1.00 | Almost perfect agreement |

### Python Calculation
```python
from sklearn.metrics import cohen_kappa_score

labels_rater1 = ['sensorineural', 'conductive', 'sensorineural', 'mixed', 'normal']
labels_rater2 = ['sensorineural', 'sensorineural', 'sensorineural', 'mixed', 'normal']

kappa = cohen_kappa_score(labels_rater1, labels_rater2)
print(f"Cohen's Kappa: {kappa:.3f}")
```

### For Multi-Dimensional Labels
Compute kappa **per dimension** (type, severity, profile separately). A single composite kappa hides which dimension is problematic.

---

## Running a Pilot Study

Before scaling to full dataset:

1. **Select 50 items** — stratified sample (not cherry-picked easy cases)
2. **Recruit 2–3 labelers** — including at least one domain expert
3. **Label independently** — no discussion, no peeking at each other
4. **Compute κ per dimension**
5. **Run a disagreement review session**:
   - For each item where labelers disagreed, discuss why
   - Is it a schema ambiguity? → Fix the definition
   - Is it a genuine hard case? → Add to the "adjudication queue"
   - Is it labeler error? → Re-train the labeler

6. **Re-run the pilot** with the updated schema until κ > 0.60
7. **Only then scale to full dataset**

---

## Gold Standard Items

### What They Are
Items with a **pre-agreed ground truth** label, verified by the most senior domain expert available.

### How Many
- 10–15% of total labeling volume
- Spread evenly across the label space (don't make all gold items easy ones)
- Refresh gold set as you discover new hard cases

### How to Use Them
- **Inject covertly** into the labeling queue — labelers should not know which items are gold
- Compare each labeler's gold answers to ground truth
- Track accuracy over time — flag if a labeler's gold accuracy drops below 80%

### What to Do With Disagreements
- Gold accuracy 80–100%: labeler in good standing
- Gold accuracy 65–79%: send re-training/calibration
- Gold accuracy < 65%: pause labeler, investigate, possibly discard their labels

---

## Adjudication Workflow

For items with genuine expert disagreement:

1. **Flag items** where labeler agreement is below threshold (e.g., κ < 0.4 locally)
2. **Senior adjudicator review** — a single domain expert makes the final call
3. **Record the reasoning** — why did they choose this label? This becomes training data for the labeling guide
4. **Update the labeling guide** with the resolved case as an example

Do not use majority vote as a substitute for adjudication on hard cases — majority vote on hard items often just averages out the confusion.

---

## Detecting Label Drift

Label drift happens when labeler behavior changes over time (fatigue, boredom, reinterpretation of schema).

**Detect it**:
- Plot **class distribution** per labeler per week — should be stable
- Plot **gold accuracy** per labeler over time — should not decline
- Plot **average labeling time** over time — should not drop dramatically

**Common causes**:
- Labeler fatigue (label time drops, quality drops)
- Ambiguous schema that labelers are resolving differently over time
- New labelers being added with different calibration

---

## Fleiss' Kappa (for 3+ Labelers)

When you have more than 2 labelers per item:

```python
import numpy as np

def fleiss_kappa(ratings):
    """
    ratings: numpy array of shape (n_items, n_raters)
    Each cell is the category assigned.
    """
    # Convert to category count matrix
    n_items, n_raters = ratings.shape
    categories = np.unique(ratings)
    n_categories = len(categories)
    
    # ... (use statsmodels or krippendorff library)
    from statsmodels.stats.inter_rater import fleiss_kappa as fk
    # Build agreement table first
    ...
```

For most projects, use `krippendorff` library — handles missing data and ordinal scales:
```bash
pip install krippendorff
```

```python
import krippendorff
alpha = krippendorff.alpha(reliability_data=your_data, level_of_measurement='nominal')
```

---

## Documenting Your Dataset (Datasheet Template)

Based on Gebru et al. (2018) "Datasheets for Datasets":

```markdown
## Dataset: [Name]

### Motivation
- Why was this dataset created?
- Who funded/sponsored this work?

### Composition  
- What does each instance represent? (one audiogram image = one instance)
- How many instances total?
- Class distribution: [table]
- Are there missing values or known gaps?

### Collection Process
- How was the raw data sourced?
- Was the data sanitized? How?
- Time period covered?

### Labeling Process
- Who were the labelers? (credentials, training)
- What instructions were provided?
- How many labels per instance?
- What was the measured inter-rater agreement (κ)?
- Was there adjudication? By whom?

### Known Limitations
- What is this dataset NOT appropriate for?
- What demographic biases may exist?
- What acquisition conditions are represented vs. missing?

### Usage and Licensing
- Who can use this dataset?
- What are the usage restrictions?
```

This datasheet should be version-controlled alongside the dataset and updated when the dataset is updated.
