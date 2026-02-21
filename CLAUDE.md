# Audiogram Labeling App

Expert labelers view sanitized audiogram images from a private Supabase Storage bucket and attach structured hearing-loss labels.

## Dev Setup

```bash
cp .env.example .env.local   # fill in values from Supabase project settings
npm install
npm run dev
```

Env vars (from Supabase project → Settings → API):
- `VITE_SUPABASE_URL` — project URL
- `VITE_SUPABASE_ANON_KEY` — anon/public key

## Deploy

Vercel or Netlify: set the two env vars above, deploy from repo root. No build config needed (Vite auto-detected).

## Acceptance Criteria

- [ ] Login with email/password → redirected to Queue
- [ ] Queue shows correct remaining count and upcoming filenames
- [ ] Case screen loads image, form submits → label row inserted in Supabase
- [ ] After submit, next case auto-loads (or "done" state if queue empty)
- [ ] Admin can upload images → cases + assignments rows created
- [ ] Logout works, redirects to Login

---

## Required Supabase Setup

Run the following SQL in Supabase → SQL Editor before using the app.

### 1. RPC Functions

```sql
-- Next unlabeled case for current user
CREATE OR REPLACE FUNCTION get_next_case()
RETURNS TABLE(id uuid, image_path text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT c.id, c.image_path, c.created_at
  FROM cases c
  JOIN assignments a ON a.case_id = c.id
  LEFT JOIN labels l ON l.case_id = c.id AND l.expert_user_id = auth.uid()
  WHERE a.expert_user_id = auth.uid()
    AND l.case_id IS NULL
  ORDER BY c.created_at ASC
  LIMIT 1;
$$;

-- Count of remaining cases for current user
CREATE OR REPLACE FUNCTION get_queue_count()
RETURNS bigint
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT COUNT(*)
  FROM cases c
  JOIN assignments a ON a.case_id = c.id
  LEFT JOIN labels l ON l.case_id = c.id AND l.expert_user_id = auth.uid()
  WHERE a.expert_user_id = auth.uid()
    AND l.case_id IS NULL;
$$;

-- Upcoming filenames for Queue list
CREATE OR REPLACE FUNCTION get_upcoming_cases(lim int DEFAULT 10)
RETURNS TABLE(id uuid, image_path text)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT c.id, c.image_path
  FROM cases c
  JOIN assignments a ON a.case_id = c.id
  LEFT JOIN labels l ON l.case_id = c.id AND l.expert_user_id = auth.uid()
  WHERE a.expert_user_id = auth.uid()
    AND l.case_id IS NULL
  ORDER BY c.created_at ASC
  LIMIT lim;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION get_next_case() TO authenticated;
GRANT EXECUTE ON FUNCTION get_queue_count() TO authenticated;
GRANT EXECUTE ON FUNCTION get_upcoming_cases(int) TO authenticated;
```

`SECURITY INVOKER` — functions run as the calling user, so RLS on underlying tables still applies. `auth.uid()` resolves correctly because the JWT context is preserved.

### 2. Performance Indexes

```sql
CREATE INDEX IF NOT EXISTS idx_assignments_expert ON assignments(expert_user_id);
CREATE INDEX IF NOT EXISTS idx_labels_expert      ON labels(expert_user_id);
CREATE INDEX IF NOT EXISTS idx_labels_case        ON labels(case_id);
```

### 3. Admin INSERT Policies

> **Superseded by §6 master patch.** §6 replaces all hardcoded-UUID policies with `profiles.role`-based RLS. Run §6 instead of the blocks below.

The old Option A (hardcoded UUID) policies are listed here for reference only — they will be dropped and recreated by the §6 patch.

### 4. Labels INSERT Policy (for expert labelers)

> **Superseded by §6 master patch.** §6 replaces the single-check policy with a stricter assignment-gated policy.

### 5. Storage Signed URL Policy (for reading images)

```sql
-- Allow authenticated users to read from audiograms bucket
CREATE POLICY "authenticated read audiograms" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'audiograms');
```

---

## Architecture Notes

- **State-based router** in `App.tsx` — no react-router dependency.
- **Labels are source of truth** — `get_next_case()` filters by `labels.case_id IS NULL`, so `cases.status` is never updated.
- **No client-side caching** — each screen transition fetches fresh data via RPC.
- **Admin upload flow**: for each file → upload to storage → insert `cases` row → insert `assignments` row.
- **Review mode** — `project_settings.review_mode` controls dispute resolution. `dual` escalates mismatches for manual review; `triage` auto-assigns a 3rd expert. All logic lives in a server-side trigger (`trg_after_label_insert`).

---

### 6. Master Patch SQL

Single paste, fully idempotent. Safe on existing `cases`, `assignments`, `labels` data.

**Admin UUID:** `d7e39847-26f1-4370-ba39-a8b49a68f8dc`

```sql
-- =============================================================
-- MASTER PATCH SQL — Audiogram Review Mode + Full RLS
-- Idempotent. Safe on existing cases/assignments/labels data.
-- Admin UUID: d7e39847-26f1-4370-ba39-a8b49a68f8dc
-- =============================================================


-- ══════════════════════════════════════════════════════════════
-- A. profiles — add role column if missing, seed admin
-- ══════════════════════════════════════════════════════════════

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'expert'
  CHECK (role IN ('admin', 'expert'));

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated read profiles" ON public.profiles;
CREATE POLICY "authenticated read profiles"
  ON public.profiles FOR SELECT TO authenticated USING (true);

INSERT INTO public.profiles (user_id, role)
VALUES ('d7e39847-26f1-4370-ba39-a8b49a68f8dc', 'admin')
ON CONFLICT (user_id) DO UPDATE SET role = 'admin';

-- Add expert labelers (one row per labeler UUID):
-- INSERT INTO public.profiles (user_id, role)
-- VALUES ('<expert-uuid>', 'expert')
-- ON CONFLICT (user_id) DO UPDATE SET role = 'expert';


-- ══════════════════════════════════════════════════════════════
-- B. project_settings — create if missing, ensure seeded
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.project_settings (
  id              int  PRIMARY KEY DEFAULT 1,
  review_mode     text NOT NULL DEFAULT 'triage'
                  CHECK (review_mode IN ('dual', 'triage')),
  overlap_percent int  NOT NULL DEFAULT 0
                  CHECK (overlap_percent BETWEEN 0 AND 100),
  CONSTRAINT single_row CHECK (id = 1)
);

INSERT INTO public.project_settings (id) VALUES (1)
  ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.project_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated read project_settings" ON public.project_settings;
CREATE POLICY "authenticated read project_settings"
  ON public.project_settings FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "admin update project_settings" ON public.project_settings;
CREATE POLICY "admin update project_settings"
  ON public.project_settings FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND role = 'admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND role = 'admin')
  );


-- ══════════════════════════════════════════════════════════════
-- C. case_resolution — create if missing
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.case_resolution (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id        uuid        NOT NULL UNIQUE REFERENCES public.cases(id),
  status         text        NOT NULL
                 CHECK (status IN ('agreed', 'disputed', 'escalated', 'resolved')),
  final_label_id uuid        REFERENCES public.labels(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.case_resolution ENABLE ROW LEVEL SECURITY;

-- Admin sees all resolutions; experts see only resolutions for their assigned cases
DROP POLICY IF EXISTS "admin all case_resolution"        ON public.case_resolution;
DROP POLICY IF EXISTS "expert read own case_resolution"  ON public.case_resolution;
DROP POLICY IF EXISTS "authenticated read case_resolution" ON public.case_resolution;

CREATE POLICY "admin all case_resolution"
  ON public.case_resolution FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "expert read own case_resolution"
  ON public.case_resolution FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.assignments
      WHERE case_id = case_resolution.case_id
        AND expert_user_id = auth.uid()
    )
  );

-- No INSERT policy for authenticated — only the SECURITY DEFINER trigger writes here
CREATE INDEX IF NOT EXISTS idx_case_resolution_status ON public.case_resolution(status);
CREATE INDEX IF NOT EXISTS idx_case_resolution_case   ON public.case_resolution(case_id);


-- ══════════════════════════════════════════════════════════════
-- D. RLS — cases
--    Admin: SELECT all + INSERT
--    Expert: SELECT only their assigned cases (no INSERT)
-- ══════════════════════════════════════════════════════════════

ALTER TABLE public.cases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin insert cases"           ON public.cases;
DROP POLICY IF EXISTS "admin select cases"           ON public.cases;
DROP POLICY IF EXISTS "expert select assigned cases" ON public.cases;

CREATE POLICY "admin select cases"
  ON public.cases FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "admin insert cases"
  ON public.cases FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "expert select assigned cases"
  ON public.cases FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.assignments
      WHERE case_id = cases.id
        AND expert_user_id = auth.uid()
    )
  );


-- ══════════════════════════════════════════════════════════════
-- E. RLS — assignments
--    Admin: SELECT all + INSERT
--    Expert: SELECT only their own rows (no INSERT — trigger handles 3rd assignment)
-- ══════════════════════════════════════════════════════════════

ALTER TABLE public.assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin insert assignments"       ON public.assignments;
DROP POLICY IF EXISTS "admin select assignments"       ON public.assignments;
DROP POLICY IF EXISTS "expert select own assignments"  ON public.assignments;

CREATE POLICY "admin select assignments"
  ON public.assignments FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "admin insert assignments"
  ON public.assignments FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "expert select own assignments"
  ON public.assignments FOR SELECT TO authenticated
  USING (expert_user_id = auth.uid());


-- ══════════════════════════════════════════════════════════════
-- F. RLS — labels
--    Admin: SELECT all + INSERT (for gold-standard seeding)
--    Expert: SELECT own labels; INSERT only if assigned to that case
-- ══════════════════════════════════════════════════════════════

ALTER TABLE public.labels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "labelers insert own labels"    ON public.labels;
DROP POLICY IF EXISTS "admin select labels"           ON public.labels;
DROP POLICY IF EXISTS "admin insert labels"           ON public.labels;
DROP POLICY IF EXISTS "expert select own labels"      ON public.labels;
DROP POLICY IF EXISTS "expert insert assigned label"  ON public.labels;

CREATE POLICY "admin select labels"
  ON public.labels FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "admin insert labels"
  ON public.labels FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "expert select own labels"
  ON public.labels FOR SELECT TO authenticated
  USING (expert_user_id = auth.uid());

-- Expert INSERT: must be labeling as themselves AND must be assigned to the case
CREATE POLICY "expert insert assigned label"
  ON public.labels FOR INSERT TO authenticated
  WITH CHECK (
    expert_user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.assignments
      WHERE case_id      = labels.case_id
        AND expert_user_id = auth.uid()
    )
  );


-- ══════════════════════════════════════════════════════════════
-- G. assignments UNIQUE constraint (idempotent)
-- ══════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.assignments'::regclass
      AND contype   = 'u'
      AND conname   = 'assignments_case_expert_unique'
  ) THEN
    ALTER TABLE public.assignments
      ADD CONSTRAINT assignments_case_expert_unique UNIQUE (case_id, expert_user_id);
  END IF;
END;
$$;


-- ══════════════════════════════════════════════════════════════
-- H. labels_equal(jsonb, jsonb)
--    Compares only clinically meaningful fields; ignores notes.
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.labels_equal(a jsonb, b jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER AS $$
  SELECT
    a->'right_ear'           = b->'right_ear'
    AND a->'left_ear'        = b->'left_ear'
    AND a->>'recommendation' = b->>'recommendation';
$$;

GRANT EXECUTE ON FUNCTION public.labels_equal(jsonb, jsonb) TO authenticated;


-- ══════════════════════════════════════════════════════════════
-- I. Trigger function — dispute resolution engine
--    SECURITY DEFINER: bypasses RLS to write assignments/case_resolution
--    from inside the labeler's label INSERT transaction.
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.trg_after_label_insert_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_label_count  int;
  v_label_a      labels%ROWTYPE;
  v_label_b      labels%ROWTYPE;
  v_mode         text;
  v_third_expert uuid;
BEGIN
  -- ── Serialize concurrent label inserts for the same case ──
  -- Two experts submitting at the same time would each see COUNT=1
  -- (their own uncommitted row only) and both skip the resolution logic.
  -- Locking the case row forces the second trigger to wait until the
  -- first transaction commits, so it then sees COUNT=2 correctly.
  PERFORM id FROM public.cases WHERE id = NEW.case_id FOR UPDATE;

  -- Only act when exactly 2 labels exist for this case
  SELECT COUNT(*) INTO v_label_count
    FROM labels WHERE case_id = NEW.case_id;

  IF v_label_count <> 2 THEN
    RETURN NEW;
  END IF;

  -- Idempotency guard: skip if resolution already recorded
  -- (belt-and-suspenders in case the FOR UPDATE doesn't fully serialize)
  IF EXISTS (SELECT 1 FROM case_resolution WHERE case_id = NEW.case_id) THEN
    RETURN NEW;
  END IF;

  -- Fetch both labels oldest-first
  SELECT * INTO v_label_a
    FROM labels WHERE case_id = NEW.case_id ORDER BY created_at ASC  LIMIT 1;
  SELECT * INTO v_label_b
    FROM labels WHERE case_id = NEW.case_id ORDER BY created_at DESC LIMIT 1;

  IF public.labels_equal(v_label_a.payload, v_label_b.payload) THEN
    -- Labels agree → finalize
    INSERT INTO public.case_resolution (case_id, status, final_label_id)
    VALUES (NEW.case_id, 'agreed', v_label_a.id)
    ON CONFLICT (case_id) DO NOTHING;

  ELSE
    SELECT review_mode INTO v_mode FROM public.project_settings WHERE id = 1;

    -- Guard: if project_settings row is missing, v_mode is NULL → default to triage
    IF v_mode IS NULL THEN
      RAISE WARNING 'project_settings row missing; defaulting to triage';
      v_mode := 'triage';
    END IF;

    IF v_mode = 'dual' THEN
      -- Mismatch, dual mode → escalate only, NO 3rd assignment
      INSERT INTO public.case_resolution (case_id, status)
      VALUES (NEW.case_id, 'escalated')
      ON CONFLICT (case_id) DO NOTHING;

    ELSE  -- 'triage'
      -- Mismatch, triage mode → disputed + auto-assign 3rd expert
      INSERT INTO public.case_resolution (case_id, status)
      VALUES (NEW.case_id, 'disputed')
      ON CONFLICT (case_id) DO NOTHING;

      -- Pick a 3rd expert from profiles.user_id:
      --   role = 'expert' (admins excluded by role check)
      --   not already assigned to this case
      SELECT p.user_id INTO v_third_expert
        FROM public.profiles p
        WHERE p.role = 'expert'
          AND p.user_id NOT IN (
            SELECT expert_user_id FROM public.assignments WHERE case_id = NEW.case_id
          )
        ORDER BY random()
        LIMIT 1;

      IF v_third_expert IS NOT NULL THEN
        INSERT INTO public.assignments (case_id, expert_user_id)
        VALUES (NEW.case_id, v_third_expert)
        ON CONFLICT (case_id, expert_user_id) DO NOTHING;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_after_label_insert ON public.labels;
CREATE TRIGGER trg_after_label_insert
  AFTER INSERT ON public.labels
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_after_label_insert_fn();


-- ══════════════════════════════════════════════════════════════
-- J. admin_create_case_with_assignments RPC
--    Call instead of direct table inserts from the frontend.
--    Accepts image_path + array of expert UUIDs.
--    Storage upload still happens client-side before calling this.
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.admin_create_case_with_assignments(
  p_image_path text,
  p_expert_ids uuid[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_case_id uuid;
BEGIN
  -- Guard: caller must be admin
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE user_id = auth.uid() AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Permission denied: admin role required';
  END IF;

  INSERT INTO public.cases (image_path)
  VALUES (p_image_path)
  RETURNING id INTO v_case_id;

  INSERT INTO public.assignments (case_id, expert_user_id)
  SELECT v_case_id, unnest(p_expert_ids)
  ON CONFLICT (case_id, expert_user_id) DO NOTHING;

  RETURN v_case_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_create_case_with_assignments(text, uuid[]) TO authenticated;


-- ══════════════════════════════════════════════════════════════
-- K. Dashboard RPCs
-- ══════════════════════════════════════════════════════════════

-- Per-expert progress (admin sees all via RLS; experts see only their own row)
CREATE OR REPLACE FUNCTION public.get_expert_stats()
RETURNS TABLE (
  expert_user_id  uuid,
  assigned_count  bigint,
  labeled_count   bigint,
  remaining_count bigint
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT
    a.expert_user_id,
    COUNT(DISTINCT a.case_id)                              AS assigned_count,
    COUNT(DISTINCT l.case_id)                              AS labeled_count,
    COUNT(DISTINCT a.case_id) - COUNT(DISTINCT l.case_id) AS remaining_count
  FROM public.assignments a
  LEFT JOIN public.labels l
    ON l.case_id = a.case_id AND l.expert_user_id = a.expert_user_id
  GROUP BY a.expert_user_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_expert_stats() TO authenticated;

-- Resolution status breakdown (all statuses)
CREATE OR REPLACE FUNCTION public.get_resolution_stats()
RETURNS TABLE (status text, cnt bigint)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT status, COUNT(*) AS cnt
  FROM public.case_resolution
  GROUP BY status;
$$;

GRANT EXECUTE ON FUNCTION public.get_resolution_stats() TO authenticated;

-- Escalated/disputed only (used by Admin screen badge)
CREATE OR REPLACE FUNCTION public.get_escalated_count()
RETURNS TABLE (status text, cnt bigint)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT status, COUNT(*) AS cnt
  FROM public.case_resolution
  WHERE status IN ('disputed', 'escalated')
  GROUP BY status;
$$;

GRANT EXECUTE ON FUNCTION public.get_escalated_count() TO authenticated;


-- ══════════════════════════════════════════════════════════════
-- L. Storage policy — replace hardcoded-UUID policy with role-based
-- ══════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "admin upload audiograms" ON storage.objects;
CREATE POLICY "admin upload audiograms"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'audiograms'
    AND name LIKE 'cases/%'
    AND EXISTS (
      SELECT 1 FROM public.profiles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- Read policy (unchanged — all authenticated users can read signed URLs)
DROP POLICY IF EXISTS "authenticated read audiograms" ON storage.objects;
CREATE POLICY "authenticated read audiograms"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'audiograms');
```

---

### 7. Verification & Acceptance Tests

Run all blocks in Supabase SQL Editor after applying §6.

#### Structural checks

```sql
-- V1. profiles columns (expect: user_id + role)
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'profiles'
ORDER BY ordinal_position;

-- V2. Admin row
SELECT user_id, role FROM public.profiles
WHERE user_id = 'd7e39847-26f1-4370-ba39-a8b49a68f8dc';
-- Expected: role = 'admin'

-- V3. Both new tables exist
SELECT
  to_regclass('public.project_settings') AS project_settings,
  to_regclass('public.case_resolution')  AS case_resolution;
-- Expected: both non-null

-- V4. project_settings row
SELECT id, review_mode, overlap_percent FROM public.project_settings;
-- Expected: id=1, review_mode='triage', overlap_percent=0

-- V5. Trigger on labels
SELECT trigger_name, event_manipulation, action_timing
FROM information_schema.triggers
WHERE trigger_schema = 'public' AND event_object_table = 'labels';
-- Expected: trg_after_label_insert | INSERT | AFTER

-- V6. Functions exist and SECURITY DEFINER correct
SELECT proname, prosecdef
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN (
    'labels_equal', 'trg_after_label_insert_fn',
    'admin_create_case_with_assignments',
    'get_expert_stats', 'get_resolution_stats', 'get_escalated_count'
  );
-- Expected: 6 rows
-- prosecdef=true for: trg_after_label_insert_fn, admin_create_case_with_assignments
-- prosecdef=false for: labels_equal, get_expert_stats, get_resolution_stats, get_escalated_count

-- V7. UNIQUE constraint on assignments
SELECT conname FROM pg_constraint
WHERE conrelid = 'public.assignments'::regclass AND contype = 'u';
-- Expected: assignments_case_expert_unique

-- V8. RLS policies per table
SELECT tablename, policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('cases', 'assignments', 'labels', 'case_resolution', 'profiles', 'project_settings')
ORDER BY tablename, cmd;
-- Expected per table:
--   cases:           admin select + admin insert + expert select assigned cases
--   assignments:     admin select + admin insert + expert select own assignments
--   labels:          admin select + admin insert + expert select own + expert insert assigned
--   case_resolution: admin all + expert read own
--   profiles:        authenticated read
--   project_settings: authenticated read + admin update

-- V9. labels_equal smoke test
SELECT
  public.labels_equal(
    '{"right_ear":{"loss_type":"normal","severity":"normal","pattern":"flat"},"left_ear":{"loss_type":"normal","severity":"normal","pattern":"flat"},"recommendation":"none","notes":"A"}'::jsonb,
    '{"right_ear":{"loss_type":"normal","severity":"normal","pattern":"flat"},"left_ear":{"loss_type":"normal","severity":"normal","pattern":"flat"},"recommendation":"none","notes":"B"}'::jsonb
  ) AS same_clinical_diff_notes,   -- expect: true
  public.labels_equal(
    '{"right_ear":{"loss_type":"sensorineural","severity":"mild","pattern":"sloping"},"left_ear":{"loss_type":"normal","severity":"normal","pattern":"flat"},"recommendation":"monitor"}'::jsonb,
    '{"right_ear":{"loss_type":"normal","severity":"normal","pattern":"flat"},"left_ear":{"loss_type":"normal","severity":"normal","pattern":"flat"},"recommendation":"none"}'::jsonb
  ) AS different_clinical;         -- expect: false
```

#### Acceptance test: trigger paths (rollback-safe)

Replace `<case-uuid>`, `<expert1-uuid>`, `<expert2-uuid>` with real values.
For triage path: ensure a 3rd user exists in `profiles` with `role='expert'` and is NOT one of the two experts below.

```sql
-- ── TEST A: AGREED path ──────────────────────────────────────
DO $$
DECLARE
  v_case_id uuid := '<case-uuid>';
  v_e1      uuid := '<expert1-uuid>';
  v_e2      uuid := '<expert2-uuid>';
  v_payload jsonb := '{"right_ear":{"loss_type":"normal","severity":"normal","pattern":"flat"},"left_ear":{"loss_type":"normal","severity":"normal","pattern":"flat"},"recommendation":"none"}'::jsonb;
  v_status  text;
  v_lid     uuid;
BEGIN
  INSERT INTO public.labels (case_id, expert_user_id, payload, confidence, duration_ms)
  VALUES (v_case_id, v_e1, v_payload, 5, 1000),
         (v_case_id, v_e2, v_payload, 5, 1000);
  SELECT status, final_label_id INTO v_status, v_lid FROM public.case_resolution WHERE case_id = v_case_id;
  RAISE NOTICE 'AGREED TEST: status=% final_label_id=%', v_status, v_lid;
  -- Expect: status='agreed', final_label_id IS NOT NULL
  RAISE EXCEPTION 'ROLLBACK';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'ROLLBACK' THEN RAISE; END IF;
  RAISE NOTICE 'Rolled back.';
END; $$;

-- ── TEST B: DUAL / ESCALATED path ────────────────────────────
DO $$
DECLARE
  v_case_id uuid := '<case-uuid>';
  v_e1      uuid := '<expert1-uuid>';
  v_e2      uuid := '<expert2-uuid>';
  v_a_count int;
  v_status  text;
BEGIN
  UPDATE public.project_settings SET review_mode = 'dual' WHERE id = 1;
  INSERT INTO public.labels (case_id, expert_user_id, payload, confidence, duration_ms) VALUES
    (v_case_id, v_e1, '{"right_ear":{"loss_type":"normal","severity":"normal","pattern":"flat"},"left_ear":{"loss_type":"normal","severity":"normal","pattern":"flat"},"recommendation":"none"}'::jsonb,   3, 1000),
    (v_case_id, v_e2, '{"right_ear":{"loss_type":"sensorineural","severity":"mild","pattern":"sloping"},"left_ear":{"loss_type":"normal","severity":"normal","pattern":"flat"},"recommendation":"monitor"}'::jsonb, 4, 2000);
  SELECT status INTO v_status FROM public.case_resolution WHERE case_id = v_case_id;
  SELECT COUNT(*) INTO v_a_count FROM public.assignments WHERE case_id = v_case_id;
  RAISE NOTICE 'DUAL TEST: status=% assignments=%', v_status, v_a_count;
  -- Expect: status='escalated', assignments = 2 (no 3rd added)
  RAISE EXCEPTION 'ROLLBACK';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'ROLLBACK' THEN RAISE; END IF;
  RAISE NOTICE 'Rolled back.';
END; $$;

-- ── TEST C: TRIAGE / DISPUTED path ───────────────────────────
DO $$
DECLARE
  v_case_id uuid := '<case-uuid>';
  v_e1      uuid := '<expert1-uuid>';
  v_e2      uuid := '<expert2-uuid>';
  v_a_count int;
  v_status  text;
BEGIN
  UPDATE public.project_settings SET review_mode = 'triage' WHERE id = 1;
  INSERT INTO public.labels (case_id, expert_user_id, payload, confidence, duration_ms) VALUES
    (v_case_id, v_e1, '{"right_ear":{"loss_type":"normal","severity":"normal","pattern":"flat"},"left_ear":{"loss_type":"normal","severity":"normal","pattern":"flat"},"recommendation":"none"}'::jsonb,   3, 1000),
    (v_case_id, v_e2, '{"right_ear":{"loss_type":"sensorineural","severity":"mild","pattern":"sloping"},"left_ear":{"loss_type":"normal","severity":"normal","pattern":"flat"},"recommendation":"monitor"}'::jsonb, 4, 2000);
  SELECT status INTO v_status FROM public.case_resolution WHERE case_id = v_case_id;
  SELECT COUNT(*) INTO v_a_count FROM public.assignments WHERE case_id = v_case_id;
  RAISE NOTICE 'TRIAGE TEST: status=% assignments=%', v_status, v_a_count;
  -- Expect: status='disputed', assignments = 3 (3rd expert added, if one exists in profiles)
  RAISE EXCEPTION 'ROLLBACK';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'ROLLBACK' THEN RAISE; END IF;
  RAISE NOTICE 'Rolled back.';
END; $$;

-- ── TEST D: Admin visibility ──────────────────────────────────
-- Run as your admin user in the Supabase dashboard (Table Editor)
-- or via the JS client logged in as admin:
--   SELECT COUNT(*) FROM cases;       -- expect: all rows
--   SELECT COUNT(*) FROM assignments; -- expect: all rows
--   SELECT COUNT(*) FROM labels;      -- expect: all rows

-- ── TEST E: Expert visibility (simulate via SQL) ──────────────
-- Impersonate an expert by setting auth context (Supabase SQL Editor → run as service role won't work;
-- use the frontend app logged in as an expert to verify queue only shows assigned cases)
```

---

### Review Mode QA Checklist

- [ ] `case_resolution` table exists (`to_regclass` returns non-null)
- [ ] `trg_after_label_insert_fn` has `prosecdef=true`
- [ ] Agreed path: 2 matching labels → `status='agreed'`, `final_label_id` set
- [ ] Dual path: 2 mismatched labels → `status='escalated'`, assignment count unchanged
- [ ] Triage path: 2 mismatched labels → `status='disputed'`, 3rd assignment created
- [ ] Idempotent: 3rd label insert on resolved case leaves `case_resolution` unchanged
- [ ] Admin sees all rows in cases, assignments, labels
- [ ] Expert sees only their assigned cases and own labels
- [ ] `admin_create_case_with_assignments` creates case + assignments in one call
- [ ] `get_expert_stats` returns per-expert labeled/remaining counts
