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

Run after the setup above. Implements dual vs triage dispute resolution, role-based access, and server-side auto-escalation.

#### 6a. Profiles Table (role management — implements Option B from §3)

```sql
CREATE TABLE IF NOT EXISTS public.profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role    text NOT NULL DEFAULT 'expert'
          CHECK (role IN ('admin', 'expert'))
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read (needed for admin checks inside trigger)
CREATE POLICY "authenticated read profiles"
  ON public.profiles FOR SELECT TO authenticated USING (true);

-- Seed your admin user (replace <your-user-uuid>)
INSERT INTO public.profiles (user_id, role)
VALUES ('<your-user-uuid>', 'admin')
ON CONFLICT (user_id) DO UPDATE SET role = 'admin';

-- Seed expert labelers (one row per labeler)
-- INSERT INTO public.profiles (user_id, role) VALUES ('<expert-uuid>', 'expert');
```

> To make a user available as a triage 3rd expert, they must have `role = 'expert'` in `profiles`. The trigger picks from this pool.

#### 6b. Project Settings Table

```sql
CREATE TABLE IF NOT EXISTS public.project_settings (
  id              int  PRIMARY KEY DEFAULT 1,
  review_mode     text NOT NULL DEFAULT 'triage'
                  CHECK (review_mode IN ('dual', 'triage')),
  overlap_percent int  NOT NULL DEFAULT 0
                  CHECK (overlap_percent BETWEEN 0 AND 100),
  CONSTRAINT single_row CHECK (id = 1)
);

-- Seed the single config row
INSERT INTO public.project_settings (id) VALUES (1)
  ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.project_settings ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read
CREATE POLICY "authenticated read project_settings"
  ON public.project_settings FOR SELECT TO authenticated USING (true);

-- Only admins can update
CREATE POLICY "admin update project_settings"
  ON public.project_settings FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE user_id = auth.uid() AND role = 'admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE user_id = auth.uid() AND role = 'admin')
  );
```

#### 6c. Case Resolution Table

```sql
CREATE TABLE IF NOT EXISTS public.case_resolution (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id        uuid        NOT NULL UNIQUE REFERENCES cases(id),
  status         text        NOT NULL
                 CHECK (status IN ('agreed', 'disputed', 'escalated', 'resolved')),
  final_label_id uuid        REFERENCES labels(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.case_resolution ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read (for admin dashboards)
CREATE POLICY "authenticated read case_resolution"
  ON public.case_resolution FOR SELECT TO authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_case_resolution_status ON case_resolution(status);
CREATE INDEX IF NOT EXISTS idx_case_resolution_case   ON case_resolution(case_id);
```

#### 6d. Assignments Uniqueness Constraint

```sql
-- Prevent duplicate assignments (safe to run even if assignments table already exists)
ALTER TABLE public.assignments
  ADD CONSTRAINT assignments_case_expert_unique UNIQUE (case_id, expert_user_id);
```

#### 6e. Labels Equal Function

Compares only clinically meaningful fields; ignores `notes`.

```sql
CREATE OR REPLACE FUNCTION public.labels_equal(a jsonb, b jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER AS $$
  SELECT
    a->'right_ear'       = b->'right_ear'
    AND a->'left_ear'    = b->'left_ear'
    AND a->>'recommendation' = b->>'recommendation';
$$;

GRANT EXECUTE ON FUNCTION public.labels_equal(jsonb, jsonb) TO authenticated;
```

#### 6f. After-Label-Insert Trigger (dispute resolution engine)

```sql
CREATE OR REPLACE FUNCTION public.trg_after_label_insert_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER          -- runs as function owner; bypasses RLS to write assignments/resolutions
SET search_path = public
AS $$
DECLARE
  v_label_count  int;
  v_label_a      labels%ROWTYPE;
  v_label_b      labels%ROWTYPE;
  v_mode         text;
  v_third_expert uuid;
BEGIN
  -- Only act when exactly 2 labels exist for this case
  SELECT COUNT(*) INTO v_label_count
    FROM labels WHERE case_id = NEW.case_id;

  IF v_label_count <> 2 THEN
    RETURN NEW;
  END IF;

  -- Idempotency guard: skip if already resolved
  IF EXISTS (SELECT 1 FROM case_resolution WHERE case_id = NEW.case_id) THEN
    RETURN NEW;
  END IF;

  -- Fetch the two labels in insertion order
  SELECT * INTO v_label_a
    FROM labels WHERE case_id = NEW.case_id ORDER BY created_at ASC  LIMIT 1;
  SELECT * INTO v_label_b
    FROM labels WHERE case_id = NEW.case_id ORDER BY created_at DESC LIMIT 1;

  IF public.labels_equal(v_label_a.payload, v_label_b.payload) THEN
    -- Labels agree → finalize
    INSERT INTO public.case_resolution (case_id, status, final_label_id)
    VALUES (NEW.case_id, 'agreed', v_label_a.id);

  ELSE
    -- Labels differ → read review mode
    SELECT review_mode INTO v_mode FROM public.project_settings WHERE id = 1;

    IF v_mode = 'dual' THEN
      -- Escalate; do NOT assign a 3rd expert
      INSERT INTO public.case_resolution (case_id, status)
      VALUES (NEW.case_id, 'escalated');

    ELSE  -- 'triage'
      INSERT INTO public.case_resolution (case_id, status)
      VALUES (NEW.case_id, 'disputed');

      -- Pick a 3rd expert not already assigned to this case
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

-- Attach trigger
DROP TRIGGER IF EXISTS trg_after_label_insert ON public.labels;
CREATE TRIGGER trg_after_label_insert
  AFTER INSERT ON public.labels
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_after_label_insert_fn();
```

#### 6g. Escalated Count RPC

```sql
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

### Review Mode QA Checklist

Run after applying §6 SQL:

- **Dual mode** — insert 2 mismatched labels for a case → `case_resolution.status = 'escalated'`; `assignments` count stays at 2.
- **Triage mode** — insert 2 mismatched labels for a case → `case_resolution.status = 'disputed'`; a 3rd `assignments` row is created for a different expert.
- **Agreed** — insert 2 matching labels → `case_resolution.status = 'agreed'`, `final_label_id` is set.
- **Idempotent** — inserting a 3rd label on an already-resolved case leaves `case_resolution` unchanged.
