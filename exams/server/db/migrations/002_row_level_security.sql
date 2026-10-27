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
