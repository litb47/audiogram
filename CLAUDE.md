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

**Option A — Restricted by user ID (preferred for now)**

Replace `<your-user-uuid>` with the actual UUID from `auth.users` (Supabase → Authentication → Users).

```sql
-- Only allow the specific admin user ID to insert cases/assignments
CREATE POLICY "admin insert cases" ON cases
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = '<your-user-uuid>');

CREATE POLICY "admin insert assignments" ON assignments
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = '<your-user-uuid>');

-- Storage: restrict to audiograms bucket, cases/ prefix, admin user only
CREATE POLICY "admin upload audiograms" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'audiograms'
    AND name LIKE 'cases/%'
    AND auth.uid() = '<your-user-uuid>'
  );
```

**Option B — Admin role flag (for later, when multiple admins)**

Add `is_admin boolean` to a `profiles` table. Policy checks `profiles.is_admin = true`. More scalable but requires the profiles table and a join.

The app will surface the Supabase error message if policies are missing or misconfigured.

### 4. Labels INSERT Policy (for expert labelers)

```sql
CREATE POLICY "labelers insert own labels" ON labels
  FOR INSERT TO authenticated
  WITH CHECK (expert_user_id = auth.uid());
```

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

### 6. Review Mode Setup

Run the **PATCH SQL** block below (single paste, idempotent). It is safe to run on a database that already has `cases`, `assignments`, and `labels` data — nothing in those tables is touched.

**Admin UUID:** `d7e39847-26f1-4370-ba39-a8b49a68f8dc`

```sql
-- ===========================================================
-- PATCH SQL — Review Mode System
-- Idempotent. Safe on existing data. Run in Supabase SQL Editor.
-- Admin UUID: d7e39847-26f1-4370-ba39-a8b49a68f8dc
-- ===========================================================


-- ── 1. profiles: add role column if missing, seed admin ─────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'expert'
  CHECK (role IN ('admin', 'expert'));

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated read profiles" ON public.profiles;
CREATE POLICY "authenticated read profiles"
  ON public.profiles FOR SELECT TO authenticated USING (true);

-- Seed admin (no angle brackets — plain UUID)
INSERT INTO public.profiles (user_id, role)
VALUES ('d7e39847-26f1-4370-ba39-a8b49a68f8dc', 'admin')
ON CONFLICT (user_id) DO UPDATE SET role = 'admin';

-- Seed expert labelers — one row per labeler UUID:
-- INSERT INTO public.profiles (user_id, role)
-- VALUES ('<expert-uuid>', 'expert')
-- ON CONFLICT (user_id) DO UPDATE SET role = 'expert';


-- ── 2. project_settings ─────────────────────────────────────

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


-- ── 3. case_resolution ──────────────────────────────────────

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

DROP POLICY IF EXISTS "authenticated read case_resolution" ON public.case_resolution;
CREATE POLICY "authenticated read case_resolution"
  ON public.case_resolution FOR SELECT TO authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_case_resolution_status ON public.case_resolution(status);
CREATE INDEX IF NOT EXISTS idx_case_resolution_case   ON public.case_resolution(case_id);


-- ── 4. assignments UNIQUE constraint (idempotent) ───────────

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


-- ── 5. labels_equal(jsonb, jsonb) ───────────────────────────
--    Compares clinically meaningful fields; ignores notes.

CREATE OR REPLACE FUNCTION public.labels_equal(a jsonb, b jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER AS $$
  SELECT
    a->'right_ear'           = b->'right_ear'
    AND a->'left_ear'        = b->'left_ear'
    AND a->>'recommendation' = b->>'recommendation';
$$;

GRANT EXECUTE ON FUNCTION public.labels_equal(jsonb, jsonb) TO authenticated;


-- ── 6. Trigger function (dispute engine) ────────────────────
--    SECURITY DEFINER so it can write to assignments/case_resolution
--    even when the calling labeler has no INSERT rights there.

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
  -- Act only when exactly 2 labels exist for this case
  SELECT COUNT(*) INTO v_label_count
    FROM labels WHERE case_id = NEW.case_id;

  IF v_label_count <> 2 THEN
    RETURN NEW;
  END IF;

  -- Idempotency guard
  IF EXISTS (SELECT 1 FROM case_resolution WHERE case_id = NEW.case_id) THEN
    RETURN NEW;
  END IF;

  -- Fetch both labels in insertion order
  SELECT * INTO v_label_a
    FROM labels WHERE case_id = NEW.case_id ORDER BY created_at ASC  LIMIT 1;
  SELECT * INTO v_label_b
    FROM labels WHERE case_id = NEW.case_id ORDER BY created_at DESC LIMIT 1;

  IF public.labels_equal(v_label_a.payload, v_label_b.payload) THEN
    -- ✓ Agreed
    INSERT INTO public.case_resolution (case_id, status, final_label_id)
    VALUES (NEW.case_id, 'agreed', v_label_a.id);

  ELSE
    SELECT review_mode INTO v_mode FROM public.project_settings WHERE id = 1;

    IF v_mode = 'dual' THEN
      -- ✗ Mismatch, dual mode → escalate, NO 3rd assignment
      INSERT INTO public.case_resolution (case_id, status)
      VALUES (NEW.case_id, 'escalated');

    ELSE  -- 'triage'
      -- ✗ Mismatch, triage mode → disputed + auto-assign 3rd expert
      INSERT INTO public.case_resolution (case_id, status)
      VALUES (NEW.case_id, 'disputed');

      -- Select from profiles.user_id: role='expert', not already assigned
      -- (admins are excluded because they have role='admin', not 'expert')
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
        VALUES (NEW.case_id, v_third_expert);
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


-- ── 7. get_escalated_count RPC ──────────────────────────────

CREATE OR REPLACE FUNCTION public.get_escalated_count()
RETURNS TABLE (status text, cnt bigint)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT status, COUNT(*) AS cnt
  FROM public.case_resolution
  WHERE status IN ('disputed', 'escalated')
  GROUP BY status;
$$;

GRANT EXECUTE ON FUNCTION public.get_escalated_count() TO authenticated;
```

---

### 6. VERIFY

Run each block in Supabase SQL Editor to confirm the patch succeeded.

```sql
-- V1. profiles schema (expect: user_id + role columns)
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'profiles'
ORDER BY ordinal_position;

-- V2. Admin row seeded correctly
SELECT user_id, role FROM public.profiles
WHERE user_id = 'd7e39847-26f1-4370-ba39-a8b49a68f8dc';
-- Expected: 1 row, role = 'admin'

-- V3. Table existence
SELECT
  to_regclass('public.project_settings') AS project_settings,
  to_regclass('public.case_resolution')  AS case_resolution;
-- Expected: both non-null

-- V4. project_settings row
SELECT id, review_mode, overlap_percent FROM public.project_settings;
-- Expected: id=1, review_mode='triage', overlap_percent=0

-- V5. Trigger attached to labels
SELECT trigger_name, event_manipulation, action_timing
FROM information_schema.triggers
WHERE trigger_schema = 'public' AND event_object_table = 'labels';
-- Expected: trg_after_label_insert, INSERT, AFTER

-- V6. Functions exist
SELECT proname, prosecdef AS security_definer
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('labels_equal', 'trg_after_label_insert_fn', 'get_escalated_count');
-- Expected: 3 rows; trg_after_label_insert_fn has prosecdef=true

-- V7. UNIQUE constraint on assignments
SELECT conname FROM pg_constraint
WHERE conrelid = 'public.assignments'::regclass AND contype = 'u';
-- Expected: assignments_case_expert_unique

-- V8. RLS policies on project_settings
SELECT policyname, cmd FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'project_settings';
-- Expected: "authenticated read project_settings" (SELECT) + "admin update project_settings" (UPDATE)

-- V9. labels_equal smoke test (no data modified)
SELECT public.labels_equal(
  '{"right_ear":{"loss_type":"normal","severity":"normal","pattern":"flat"},"left_ear":{"loss_type":"normal","severity":"normal","pattern":"flat"},"recommendation":"none","notes":"ignored"}'::jsonb,
  '{"right_ear":{"loss_type":"normal","severity":"normal","pattern":"flat"},"left_ear":{"loss_type":"normal","severity":"normal","pattern":"flat"},"recommendation":"none","notes":"different note"}'::jsonb
) AS should_be_true;
-- Expected: true (notes field is ignored)

SELECT public.labels_equal(
  '{"right_ear":{"loss_type":"sensorineural","severity":"mild","pattern":"sloping"},"left_ear":{"loss_type":"normal","severity":"normal","pattern":"flat"},"recommendation":"monitor"}'::jsonb,
  '{"right_ear":{"loss_type":"normal","severity":"normal","pattern":"flat"},"left_ear":{"loss_type":"normal","severity":"normal","pattern":"flat"},"recommendation":"none"}'::jsonb
) AS should_be_false;
-- Expected: false
```

**Trigger path test (uses a transaction that rolls back — no real data harmed):**

```sql
-- Replace the two UUIDs with real values from your cases and auth.users tables.
-- After ROLLBACK nothing is committed.
DO $$
DECLARE
  v_case_id   uuid := '<a-real-case-uuid-from-cases>';   -- pick one from: SELECT id FROM cases LIMIT 1
  v_expert1   uuid := 'd7e39847-26f1-4370-ba39-a8b49a68f8dc';
  v_expert2   uuid := '<a-second-user-uuid>';              -- any other user in auth.users
  v_mode      text;
  v_res_status text;
  v_assign_cnt int;
BEGIN
  -- Check current review_mode
  SELECT review_mode INTO v_mode FROM public.project_settings WHERE id = 1;
  RAISE NOTICE 'review_mode = %', v_mode;

  -- Insert two mismatched labels (different right_ear loss_type)
  INSERT INTO public.labels (case_id, expert_user_id, payload, confidence, duration_ms)
  VALUES
    (v_case_id, v_expert1, '{"right_ear":{"loss_type":"normal","severity":"normal","pattern":"flat"},"left_ear":{"loss_type":"normal","severity":"normal","pattern":"flat"},"recommendation":"none"}'::jsonb, 3, 1000),
    (v_case_id, v_expert2, '{"right_ear":{"loss_type":"sensorineural","severity":"mild","pattern":"sloping"},"left_ear":{"loss_type":"normal","severity":"normal","pattern":"flat"},"recommendation":"monitor"}'::jsonb, 4, 2000);

  -- Read result
  SELECT status INTO v_res_status FROM public.case_resolution WHERE case_id = v_case_id;
  SELECT COUNT(*) INTO v_assign_cnt FROM public.assignments WHERE case_id = v_case_id;

  RAISE NOTICE 'case_resolution.status = % (expected: % mode → escalated or disputed)', v_res_status, v_mode;
  RAISE NOTICE 'assignments count = % (triage adds 1 if 3rd expert available)', v_assign_cnt;

  -- Always roll back so test data is never committed
  RAISE EXCEPTION 'ROLLBACK_SENTINEL';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'ROLLBACK_SENTINEL' THEN
    RAISE;  -- re-raise real errors
  END IF;
  RAISE NOTICE 'Rolled back — no data committed.';
END;
$$;
```

---

### Review Mode QA Checklist

- **Agreed** — 2 labels with identical `right_ear`, `left_ear`, `recommendation` → `case_resolution.status = 'agreed'`, `final_label_id` populated.
- **Dual / escalated** — set `review_mode = 'dual'`, insert 2 mismatched labels → `status = 'escalated'`, `assignments` count unchanged.
- **Triage / disputed** — set `review_mode = 'triage'`, insert 2 mismatched labels → `status = 'disputed'`, new `assignments` row for a 3rd expert (requires at least one `profiles` row with `role = 'expert'` not already assigned).
- **Idempotent** — inserting a 3rd label on an already-resolved case leaves `case_resolution` unchanged (guard: `IF EXISTS ... RETURN NEW`).
- **Admin toggle works** — `UPDATE public.project_settings SET review_mode = 'dual' WHERE id = 1` succeeds for admin UUID, returns error for non-admin.
