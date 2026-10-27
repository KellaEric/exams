-- KellasTech Examination Portal: complete database setup for the Supabase SQL editor (run ONCE, on an empty project).
-- Optional: the portal applies the same migrations itself on first start. If you run this file, it records them so they are not repeated.
-- Safe to read: contains no secrets and no user accounts.
begin;
create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now());

-- ===== 001_init.sql =====
-- KellasTech Examination Portal: core schema (PostgreSQL 14+). Timestamps are timestamptz (UTC); display zone is Africa/Accra.
-- Marks use double precision so every driver returns JS numbers; the application rounds to 2 decimals.

create table roles (
  key text primary key, label text not null, description text, is_system boolean not null default true
);
create table permissions (key text primary key, description text);
create table role_permissions (
  role_key text not null references roles(key) on delete cascade,
  permission_key text not null references permissions(key) on delete cascade,
  primary key (role_key, permission_key)
);

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  password_hash text,
  full_name text not null,
  role_key text not null references roles(key),
  status text not null default 'pending' check (status in ('invited','pending','active','suspended','deactivated')),
  student_number text,
  phone text,
  email_verified_at timestamptz,
  mfa_secret text,
  mfa_enabled boolean not null default false,
  failed_logins integer not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index users_email_uq on users (lower(email));
create unique index users_student_number_uq on users (lower(student_number)) where student_number is not null;
create index users_role_idx on users (role_key, status);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  csrf_token text not null,
  ip text, user_agent text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index sessions_user_idx on sessions (user_id);

create table auth_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  purpose text not null check (purpose in ('reset','invite','verify')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table auth_throttle (
  key text primary key,
  count integer not null default 0,
  window_started timestamptz not null,
  locked_until timestamptz
);

create table outbox (
  id uuid primary key default gen_random_uuid(),
  to_email text not null, subject text not null, body text not null,
  status text not null default 'queued' check (status in ('queued','sent','failed')),
  error text, created_at timestamptz not null default now(), sent_at timestamptz
);

-- Organisation structure: Institution (system_config) -> Department -> Programme -> Course
create table departments (
  id uuid primary key default gen_random_uuid(),
  name text not null, slug text not null unique, description text,
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now()
);
create table programmes (
  id uuid primary key default gen_random_uuid(),
  department_id uuid references departments(id),
  name text not null, slug text not null unique, description text,
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now()
);
create table terms (
  id uuid primary key default gen_random_uuid(),
  name text not null, academic_year text not null,
  starts_on date, ends_on date,
  status text not null default 'active' check (status in ('planned','active','closed')),
  unique (academic_year, name)
);
create table cohorts (
  id uuid primary key default gen_random_uuid(),
  name text not null, programme_id uuid references programmes(id), term_id uuid references terms(id),
  unique (name, term_id)
);

create table courses (
  id uuid primary key default gen_random_uuid(),
  code text,
  title text not null,
  slug text not null unique,
  norm_title text not null,
  description text, category text, level text, instructor_name text,
  department_id uuid references departments(id),
  programme_id uuid references programmes(id),
  status text not null default 'active' check (status in ('active','inactive','archived')),
  source text not null default 'manual',
  source_ref text,
  verified boolean not null default false,
  import_status text not null default 'manual' check (import_status in ('manual','imported_verified','imported_incomplete','needs_confirmation')),
  missing_fields jsonb not null default '[]',
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index courses_norm_title_uq on courses (norm_title);
create unique index courses_code_uq on courses (lower(code)) where code is not null;
create unique index courses_source_ref_uq on courses (source, source_ref) where source_ref is not null;

create table catalogue_syncs (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('dry_run','apply')),
  source text not null,
  outcome text not null check (outcome in ('ok','partial','failed')),
  summary jsonb not null default '{}',
  report jsonb not null default '{}',
  started_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table course_offerings (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references courses(id),
  term_id uuid references terms(id),
  cohort_id uuid references cohorts(id),
  label text,
  status text not null default 'open' check (status in ('planned','open','closed','archived')),
  created_at timestamptz not null default now()
);
-- one offering per course/term/cohort combination (nulls compare equal via coalesce)
create unique index offerings_uq on course_offerings (
  course_id,
  coalesce(term_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(cohort_id, '00000000-0000-0000-0000-000000000000'::uuid)
);
create table offering_staff (
  offering_id uuid not null references course_offerings(id) on delete cascade,
  user_id uuid not null references users(id),
  staff_role text not null check (staff_role in ('instructor','teaching_assistant')),
  assigned_at timestamptz not null default now(),
  primary key (offering_id, user_id)
);
create index offering_staff_user_idx on offering_staff (user_id);
create table enrolments (
  id uuid primary key default gen_random_uuid(),
  offering_id uuid not null references course_offerings(id) on delete cascade,
  student_id uuid not null references users(id),
  status text not null default 'active' check (status in ('requested','active','withdrawn','completed')),
  enrolled_at timestamptz not null default now(),
  unique (offering_id, student_id)
);
create index enrolments_student_idx on enrolments (student_id, status);

-- Assessments, question bank
create table assessment_categories (
  key text primary key, label text not null,
  kind text not null default 'exam' check (kind in ('exam','assignment','practical','project','oral')),
  requires_approval boolean not null default false,
  timed_by_default boolean not null default false,
  enabled boolean not null default true,
  sort_order integer not null default 0
);
create table files (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id),
  course_id uuid references courses(id),
  purpose text not null check (purpose in ('question_attachment','answer_upload','course_resource','assignment_brief')),
  original_name text not null, mime text not null, size_bytes integer not null,
  sha256 text not null, storage_key text not null,
  created_at timestamptz not null default now()
);
create table questions (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references courses(id),
  topic text,
  category_key text references assessment_categories(key),
  type text not null check (type in ('mcq','multi_select','true_false','short_answer','fill_blank','essay','numeric','matching','ordering','code','file_upload','practical')),
  difficulty text not null default 'medium' check (difficulty in ('easy','medium','hard')),
  marks double precision not null check (marks > 0),
  stem text not null,
  instructions text,
  attachment_file_id uuid references files(id),
  config jsonb not null default '{}',        -- student-visible settings (blank count, languages, matching lists, ordering items ...)
  answer_key jsonb not null default '{}',    -- SERVER ONLY
  rubric jsonb not null default '[]',        -- [{criterion,max,description}]; shown to students only if the assessment allows it
  explanation text,
  status text not null default 'draft' check (status in ('draft','in_review','approved','retired')),
  author_id uuid not null references users(id),
  reviewer_id uuid references users(id),
  approved_by uuid references users(id),
  approved_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index questions_course_idx on questions (course_id, status);
create table question_options (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references questions(id) on delete cascade,
  position integer not null,
  text text not null,
  is_correct boolean not null default false,  -- SERVER ONLY
  feedback text
);
create index question_options_q_idx on question_options (question_id, position);
create table question_versions (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references questions(id) on delete cascade,
  version integer not null,
  snapshot jsonb not null,
  changed_by uuid references users(id),
  reason text,
  created_at timestamptz not null default now(),
  unique (question_id, version)
);

create table grading_scales (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  bands jsonb not null,             -- [{min:90,label:'A+'}, ...] sorted high to low
  is_default boolean not null default false
);

create table assessments (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references courses(id),
  offering_id uuid references course_offerings(id),
  category_key text not null references assessment_categories(key),
  title text not null,
  instructions text,
  status text not null default 'draft' check (status in ('draft','pending_review','approved','scheduled','published','in_progress','closed','graded','results_released','archived')),
  opens_at timestamptz, closes_at timestamptz,
  duration_minutes integer check (duration_minutes is null or duration_minutes > 0),
  max_attempts integer check (max_attempts is null or max_attempts > 0),   -- null = unlimited
  total_marks double precision not null default 0,
  expected_total_marks double precision,
  pass_percentage double precision not null default 50 check (pass_percentage between 0 and 100),
  randomize_questions boolean not null default false,
  randomize_options boolean not null default false,
  allow_navigation boolean not null default true,
  feedback_mode text not null default 'marks_and_feedback' check (feedback_mode in ('none','score_only','marks_and_feedback','full')),
  results_release_at timestamptz,
  results_released_at timestamptz,
  grading_scale_id uuid references grading_scales(id),
  negative_marking boolean not null default false,
  settings jsonb not null default '{}',   -- allowed_resources, submission rules, late policy, show_rubric, allowed_file_types, max_file_mb ...
  created_by uuid not null references users(id),
  approved_by uuid references users(id),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index assessments_course_idx on assessments (course_id, status);
create table assessment_questions (
  assessment_id uuid not null references assessments(id) on delete cascade,
  question_id uuid not null references questions(id),
  position integer not null,
  marks double precision not null check (marks > 0),
  snapshot jsonb,               -- frozen copy (with keys) taken at approval/publication; SERVER ONLY
  primary key (assessment_id, question_id)
);

create table attempts (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references assessments(id),
  student_id uuid not null references users(id),
  attempt_no integer not null,
  status text not null default 'in_progress' check (status in ('in_progress','submitted','auto_submitted')),
  started_at timestamptz not null,
  deadline_at timestamptz not null,
  submitted_at timestamptz,
  extra_seconds integer not null default 0,
  late boolean not null default false,
  late_penalty_pct double precision not null default 0,
  question_order jsonb not null default '[]',
  option_orders jsonb not null default '{}',
  receipt_code text unique,
  start_key text,
  score double precision, max_score double precision, percentage double precision, passed boolean,
  grading_status text not null default 'not_graded' check (grading_status in ('not_graded','awaiting_manual','graded')),
  graded_at timestamptz,
  reopened_count integer not null default 0,
  created_at timestamptz not null default now(),
  unique (assessment_id, student_id, attempt_no)
);
-- The guard against duplicate/concurrent starts: only one live attempt per student per assessment.
create unique index attempts_one_active_uq on attempts (assessment_id, student_id) where status = 'in_progress';
create index attempts_student_idx on attempts (student_id);
create index attempts_deadline_idx on attempts (deadline_at) where status = 'in_progress';
create table answers (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references attempts(id) on delete cascade,
  question_id uuid not null references questions(id),
  response jsonb,
  flagged boolean not null default false,
  seq integer not null default 0,
  saved_at timestamptz not null,
  unique (attempt_id, question_id)
);
create table answer_grades (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references attempts(id) on delete cascade,
  question_id uuid not null references questions(id),
  max_marks double precision not null,
  auto_marks double precision,
  final_marks double precision,
  status text not null check (status in ('auto','needs_review','pending_manual','final')),
  feedback text,
  rubric_scores jsonb,
  details jsonb,
  grader_id uuid references users(id),
  graded_at timestamptz,
  unique (attempt_id, question_id)
);
create table grade_changes (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references attempts(id) on delete cascade,
  question_id uuid references questions(id),
  old_marks double precision, new_marks double precision,
  reason text not null,
  changed_by uuid not null references users(id),
  created_at timestamptz not null default now()
);
create table attempt_events (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references attempts(id) on delete cascade,
  type text not null,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index attempt_events_idx on attempt_events (attempt_id, created_at);

create table accommodations (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references users(id),
  assessment_id uuid references assessments(id),
  offering_id uuid references course_offerings(id),
  extra_minutes integer not null default 0 check (extra_minutes >= 0),
  allow_late_until timestamptz,
  extra_attempts integer not null default 0 check (extra_attempts >= 0),
  reason text not null,
  approved_by uuid not null references users(id),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (assessment_id is not null or offering_id is not null)
);
create table incidents (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references users(id),
  assessment_id uuid references assessments(id),
  attempt_id uuid references attempts(id),
  kind text not null default 'technical' check (kind in ('technical','dispute','accessibility','integrity')),
  description text not null,
  status text not null default 'open' check (status in ('open','investigating','resolved','dismissed')),
  resolution text,
  resolved_by uuid references users(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create table announcements (
  id uuid primary key default gen_random_uuid(),
  course_id uuid references courses(id),
  offering_id uuid references course_offerings(id),
  title text not null, body text not null,
  author_id uuid not null references users(id),
  published_at timestamptz not null default now()
);
create table announcement_reads (
  announcement_id uuid not null references announcements(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (announcement_id, user_id)
);
create table audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  actor_label text,
  action text not null,
  entity_type text, entity_id text,
  meta jsonb not null default '{}',
  ip text,
  created_at timestamptz not null default now()
);
create index audit_action_idx on audit_events (action, created_at desc);
create index audit_actor_idx on audit_events (actor_id, created_at desc);
create table system_config (key text primary key, value jsonb not null, updated_at timestamptz not null default now());

insert into schema_migrations(name) values ('001_init.sql');

-- ===== 002_row_level_security.sql =====
-- Lock the public Supabase API (anon / authenticated roles) out of every table. The portal's API connects with the table-owner
-- database role, which is not affected by RLS, and does its own authorisation. With RLS enabled and NO policies, the
-- PostgREST/Data API cannot read or write anything. Harmless on plain PostgreSQL.
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;

insert into schema_migrations(name) values ('002_row_level_security.sql');
commit;
