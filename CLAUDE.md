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
