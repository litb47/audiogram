# Audiogram Domain Knowledge

## What is an Audiogram?

An audiogram is a graph that visualizes the results of a hearing test (pure-tone audiometry). It shows the **softest sound a person can hear** at different frequencies.

- **X-axis**: Frequency in Hz (125 → 8000 Hz), representing pitch from low to high
- **Y-axis**: Hearing level in dB HL (−10 to 120 dB), where higher = greater hearing loss
- **Symbols**: 
  - `O` = right ear, air conduction (unmasked)
  - `X` = left ear, air conduction (unmasked)  
  - `[` = right ear, bone conduction (unmasked)
  - `]` = left ear, bone conduction (unmasked)
  - Masked versions use filled symbols

## Types of Hearing Loss

### Sensorineural Hearing Loss (SNHL)
- Air-bone gap is **absent** (AC ≈ BC)
- Caused by damage to the inner ear (cochlea) or auditory nerve
- Permanent; usually treated with hearing aids or cochlear implants
- Most common type; associated with aging (presbycusis), noise exposure, genetics

### Conductive Hearing Loss (CHL)
- Air-bone gap is **present** (AC worse than BC by ≥10 dB at 2+ frequencies)
- Sound is blocked in the outer or middle ear (wax, fluid, perforated eardrum, ossicle problems)
- Often treatable medically or surgically

### Mixed Hearing Loss
- Both a sensorineural component AND a conductive component
- BC thresholds are elevated AND there is an additional air-bone gap

## Severity Classification (WHO/ASHA Standard)
Based on the **Pure Tone Average (PTA)** = average of thresholds at 500, 1000, 2000, 4000 Hz:

| PTA (dB HL)  | Severity       |
|--------------|---------------|
| −10 to 25    | Normal         |
| 26 to 40     | Mild           |
| 41 to 55     | Moderate       |
| 56 to 70     | Moderately Severe |
| 71 to 90     | Severe         |
| 91+          | Profound       |

## Frequency Profile Shapes

- **Flat**: Similar thresholds across all frequencies
- **Sloping (high-frequency)**: Good low-frequency hearing, worse at high frequencies (most common SNHL pattern)
- **Rising (low-frequency)**: Worse at low frequencies, better at high (Ménière's disease pattern)
- **Notched**: Dip around 4000 Hz — classic noise-induced hearing loss pattern
- **Cookie-bite**: Worse in mid-frequencies (some genetic causes)
- **Precipitous**: Sudden steep drop at a specific frequency

## Laterality
- **Unilateral**: One ear affected
- **Bilateral symmetric**: Both ears affected similarly
- **Bilateral asymmetric**: Both ears affected but meaningfully different (>15 dB difference at 2+ frequencies — warrants medical referral)

## Image Quality Issues Common in Audiogram Scans
- Faded or smudged symbols
- Missing axis labels or units
- Scanned at angle / rotated
- Multiple audiograms on one page
- Handwritten vs. printed forms
- Overlapping symbols when AC and BC are very close

## Recommended Label Schema for ML

```json
{
  "image_id": "string",
  "image_quality": "good | degraded | unreadable",
  "right_ear": {
    "severity": "normal | mild | moderate | moderately_severe | severe | profound",
    "type": "sensorineural | conductive | mixed | normal | cannot_determine",
    "frequency_profile": "flat | sloping | rising | notched | cookie_bite | precipitous | other",
    "confidence": "high | medium | low"
  },
  "left_ear": {
    "severity": "...",
    "type": "...",
    "frequency_profile": "...",
    "confidence": "..."
  },
  "laterality": "unilateral_right | unilateral_left | bilateral_symmetric | bilateral_asymmetric | normal_bilateral",
  "notes": "free text for ambiguous cases",
  "labeler_id": "string",
  "labeled_at": "ISO timestamp"
}
```

## Audiological Standards to Be Aware Of
- **ANSI S3.21** — Methods for manual pure-tone audiometry
- **WHO grading system** — uses better-ear PTA; different thresholds than above
- **ICD-10-CM codes**: H90.x for conductive, H91.x for sensorineural — if clinical compatibility needed

## Common Labeler Errors to Guard Against
1. Labeling only the worse ear, ignoring the better ear
2. Confusing bone conduction and air conduction symbols
3. Calling a borderline 25 dB threshold "normal" or "mild" inconsistently — anchor on the cutoff
4. Missing a conductive component when both ears are generally bad
5. Marking "cannot determine" for any non-pristine image — set a clear quality threshold
