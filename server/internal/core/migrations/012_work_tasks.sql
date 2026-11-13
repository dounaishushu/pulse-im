CREATE TABLE pulse.work_questions (
 id uuid PRIMARY KEY,code uuid NOT NULL UNIQUE,media_id uuid REFERENCES pulse.media(id),image_url text NOT NULL DEFAULT '',correct boolean NOT NULL,
 version bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((media_id IS NOT NULL)<>(image_url<>''))
);
CREATE INDEX work_questions_answer ON pulse.work_questions(correct,id);
CREATE TABLE pulse.work_tasks (
 id uuid PRIMARY KEY,task_key varchar(64) NOT NULL UNIQUE,name varchar(120) NOT NULL,description text NOT NULL DEFAULT '',open_time time NOT NULL,
 estimated_minutes integer NOT NULL CHECK(estimated_minutes BETWEEN 1 AND 1440),question_count integer NOT NULL CHECK(question_count BETWEEN 2 AND 1000 AND question_count%2=0),
 intern_millis bigint NOT NULL CHECK(intern_millis BETWEEN 0 AND 100000000),formal_millis bigint NOT NULL CHECK(formal_millis BETWEEN 0 AND 100000000),
 enabled boolean NOT NULL DEFAULT false,sort_order integer NOT NULL DEFAULT 0,version bigint NOT NULL DEFAULT 1,
 created_by uuid NOT NULL REFERENCES pulse.admin_accounts(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(question_count*intern_millis<=9999999999 AND question_count*formal_millis<=9999999999)
);
CREATE TABLE pulse.work_codes(task_id uuid NOT NULL REFERENCES pulse.work_tasks(id) ON DELETE CASCADE,task_date date NOT NULL,code char(6) NOT NULL,version bigint NOT NULL DEFAULT 1,PRIMARY KEY(task_id,task_date));
CREATE TABLE pulse.work_daily(task_id uuid NOT NULL REFERENCES pulse.work_tasks(id) ON DELETE CASCADE,task_date date NOT NULL,questions jsonb NOT NULL,PRIMARY KEY(task_id,task_date));
CREATE TABLE pulse.work_records (
 id uuid PRIMARY KEY,task_id uuid NOT NULL REFERENCES pulse.work_tasks(id),user_id uuid NOT NULL REFERENCES pulse.users(id),task_date date NOT NULL,
 employee_type text NOT NULL CHECK(employee_type IN('intern','formal')),unit_millis bigint NOT NULL,
 status text NOT NULL DEFAULT 'in_progress' CHECK(status IN('in_progress','pending_review','reviewed')),
 questions jsonb NOT NULL,answers jsonb NOT NULL DEFAULT '{}',results jsonb NOT NULL DEFAULT '{}',review_note text NOT NULL DEFAULT '',
 total integer NOT NULL,correct_count integer NOT NULL DEFAULT 0,wage_millis bigint NOT NULL DEFAULT 0 CHECK(wage_millis BETWEEN 0 AND 9999999999),
 started_at timestamptz NOT NULL DEFAULT now(),submitted_at timestamptz,reviewed_at timestamptz,duration_seconds bigint NOT NULL DEFAULT 0,
 version bigint NOT NULL DEFAULT 1,review_request varchar(64),review_hash bytea,
 UNIQUE(task_id,user_id,task_date)
);
CREATE INDEX work_records_user ON pulse.work_records(user_id,task_date DESC,id);
CREATE INDEX work_records_date ON pulse.work_records(task_date DESC,id);
CREATE TABLE pulse.work_record_media(record_id uuid NOT NULL REFERENCES pulse.work_records(id),media_id uuid NOT NULL REFERENCES pulse.media(id),PRIMARY KEY(record_id,media_id));
