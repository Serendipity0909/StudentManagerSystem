-- =============================================================================
-- ddl-v2.sql —— 教务管理平台 增量建表脚本（PostgreSQL / 云数据库）
--
-- 执行方式：workbuddy-cloud-service MCP → workbuddy_cloudservice_db_exec_sql
--           mode = 'migrate'（管理员角色，绕过 RLS 才能建表/建策略）
--           单次只能执行一条语句，因此每张表封成一个 DO 块（一个 DO 块 = 一条语句）。
--
-- 【列风格依据实测】2026-11-10 用 db_describe_table('score_records') 实测既有表：
--   id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY   ← 平台风格，不是 uuid
--   owner_id    text NOT NULL DEFAULT auth.uid()
--   owner_name  text
--   last_editor text
--   created_at / updated_at  timestamp with time zone NOT NULL DEFAULT now()
--   业务列 snake_case（stu_name / class_name / exam）
-- 故 ARCH-v2 §2.3 里的 `id uuid DEFAULT gen_random_uuid()` 一律改为 bigint 自增主键，
-- 并补上 owner_id / owner_name 溯源列（与 score_records 对齐）。
--
-- 【RLS 依据实测】db_list_rls() 显示 score_records 现行策略为「登录用户共享读写、无
-- owner 隔离」，依赖三个 SECURITY DEFINER 辅助函数：
--   is_viewer()  status IN ('active','readonly')  → SELECT
--   is_editor()  status = 'active'                → INSERT / UPDATE / DELETE
-- 新 7 张表复制同一套策略名与判定，不自创 owner 隔离。
--
-- 【授权】score_records 实测授权：anon=SELECT，authenticated=SELECT/INSERT/UPDATE/DELETE。
-- 新表同样两行 GRANT，并显式给 authenticated 自增序列的 USAGE（漏则 insert 报 42501）。
--
-- 幂等性：CREATE TABLE / INDEX 用 IF NOT EXISTS；POLICY 无 IF NOT EXISTS，
-- 统一先 DROP POLICY IF EXISTS 再 CREATE（重复执行不会报错）。
--
-- 【T9 变更】contract_prices 由「年份×年级×阶段×方案」的细粒度行改为「一个报读方案一行」：
--   stage/plan/sessions 三列删除 → plan_name + stages jsonb + discount_type/discount_value，
--   唯一键随之改为 (year, grade, plan_name)。线上迁移走 DROP TABLE 重建（迁移时表内
--   仅 2 行手工测试数据，已确认后执行），contracts 表结构与 contracts.items 快照格式不受影响。
--
-- 【T11 变更】contract_prices 增列 remark（方案备注，text NOT NULL DEFAULT ''），
--   非破坏性 ADD COLUMN，已对线上库执行并实测备注往返（含中文与单引号）：
--   INSERT → SELECT → DELETE 全通，RLS 4 条策略与 GRANT 不变。
--   contracts 侧无 DDL 变化：多方案快照写在 items.plans[] 数组里，
--   contracts.plan 存「方案名+方案名」（如「寒春连报+暑期班」）；
--   contracts.discount_type 在「各方案优惠不同」时取 'mixed'（该列无 CHECK 约束，已实测写入）。
--   旧快照（T9 items.plan 单方案 / 更早 items.lines）无需迁移，前端三格式并存渲染。
-- =============================================================================


-- ① 学生档案：唯一键 姓名 + 学校 + 年级
DO $ddl$
BEGIN
  CREATE TABLE IF NOT EXISTS students (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id    text        DEFAULT auth.uid(),
    owner_name  text,
    last_editor text        NOT NULL DEFAULT '',
    stu_name    text        NOT NULL,
    school      text        NOT NULL,
    grade       text        NOT NULL,
    phone       text        NOT NULL DEFAULT '',
    subjects    jsonb       NOT NULL DEFAULT '[]'::jsonb,
    teachers    jsonb       NOT NULL DEFAULT '[]'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uk_students_key ON students (stu_name, school, grade);
  CREATE INDEX IF NOT EXISTS idx_students_school ON students (school);

  ALTER TABLE students ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS students_read_team ON students;
  CREATE POLICY students_read_team ON students FOR SELECT USING (is_viewer());
  DROP POLICY IF EXISTS students_insert_team ON students;
  CREATE POLICY students_insert_team ON students FOR INSERT WITH CHECK (is_editor());
  DROP POLICY IF EXISTS students_update_team ON students;
  CREATE POLICY students_update_team ON students FOR UPDATE USING (is_editor()) WITH CHECK (is_editor());
  DROP POLICY IF EXISTS students_delete_team ON students;
  CREATE POLICY students_delete_team ON students FOR DELETE USING (is_editor());

  GRANT SELECT ON students TO anon;
  GRANT SELECT, INSERT, UPDATE, DELETE ON students TO authenticated;
  GRANT USAGE, SELECT ON SEQUENCE students_id_seq TO authenticated;
END
$ddl$;


-- ② 班级：唯一键 班级名称
DO $ddl$
BEGIN
  CREATE TABLE IF NOT EXISTS classes (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id    text        DEFAULT auth.uid(),
    owner_name  text,
    last_editor text        NOT NULL DEFAULT '',
    class_name  text        NOT NULL,
    teachers    jsonb       NOT NULL DEFAULT '[]'::jsonb,
    room        text        NOT NULL DEFAULT '',
    schedules   jsonb       NOT NULL DEFAULT '[]'::jsonb,   -- [{weekday:1..7,start:'18:30',end:'20:30'}]
    grade       text        NOT NULL DEFAULT '',
    subject     text        NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uk_classes_name ON classes (class_name);

  ALTER TABLE classes ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS classes_read_team ON classes;
  CREATE POLICY classes_read_team ON classes FOR SELECT USING (is_viewer());
  DROP POLICY IF EXISTS classes_insert_team ON classes;
  CREATE POLICY classes_insert_team ON classes FOR INSERT WITH CHECK (is_editor());
  DROP POLICY IF EXISTS classes_update_team ON classes;
  CREATE POLICY classes_update_team ON classes FOR UPDATE USING (is_editor()) WITH CHECK (is_editor());
  DROP POLICY IF EXISTS classes_delete_team ON classes;
  CREATE POLICY classes_delete_team ON classes FOR DELETE USING (is_editor());

  GRANT SELECT ON classes TO anon;
  GRANT SELECT, INSERT, UPDATE, DELETE ON classes TO authenticated;
  GRANT USAGE, SELECT ON SEQUENCE classes_id_seq TO authenticated;
END
$ddl$;


-- ③ 学生 ↔ 班级 多对多桥表（无外键；删除=只删本表行）
DO $ddl$
BEGIN
  CREATE TABLE IF NOT EXISTS class_members (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id    text        DEFAULT auth.uid(),
    owner_name  text,
    last_editor text        NOT NULL DEFAULT '',
    class_id    bigint      NOT NULL,
    student_id  bigint      NOT NULL,
    joined_at   timestamptz NOT NULL DEFAULT now(),
    created_by  text        NOT NULL DEFAULT ''
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uk_members_pair ON class_members (class_id, student_id);
  CREATE INDEX IF NOT EXISTS idx_members_student ON class_members (student_id);

  ALTER TABLE class_members ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS class_members_read_team ON class_members;
  CREATE POLICY class_members_read_team ON class_members FOR SELECT USING (is_viewer());
  DROP POLICY IF EXISTS class_members_insert_team ON class_members;
  CREATE POLICY class_members_insert_team ON class_members FOR INSERT WITH CHECK (is_editor());
  DROP POLICY IF EXISTS class_members_update_team ON class_members;
  CREATE POLICY class_members_update_team ON class_members FOR UPDATE USING (is_editor()) WITH CHECK (is_editor());
  DROP POLICY IF EXISTS class_members_delete_team ON class_members;
  CREATE POLICY class_members_delete_team ON class_members FOR DELETE USING (is_editor());

  GRANT SELECT ON class_members TO anon;
  GRANT SELECT, INSERT, UPDATE, DELETE ON class_members TO authenticated;
  GRANT USAGE, SELECT ON SEQUENCE class_members_id_seq TO authenticated;
END
$ddl$;


-- ④ 客户（与学生零关联；转介绍内嵌 4 列；软查重故不建唯一索引）
DO $ddl$
BEGIN
  CREATE TABLE IF NOT EXISTS customers (
    id                   bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id             text         DEFAULT auth.uid(),
    owner_name           text,
    last_editor          text         NOT NULL DEFAULT '',
    stu_name             text         NOT NULL,
    school               text         NOT NULL DEFAULT '',
    phone                text         NOT NULL,
    grade                text         NOT NULL DEFAULT '',
    resource_type        text         NOT NULL,
    created_at           timestamptz  NOT NULL DEFAULT now(),  -- 录入时间：只读，总资源数周期基准
    intended_product     text         NOT NULL DEFAULT '',
    intended_subjects    jsonb        NOT NULL DEFAULT '[]'::jsonb,
    appointment_at       timestamptz,
    visited              boolean      NOT NULL DEFAULT false,
    visit_at             timestamptz,
    test_status          text         NOT NULL DEFAULT '未测评',
    suggested_class_type text         NOT NULL DEFAULT '',
    paid                 boolean      NOT NULL DEFAULT false,
    paid_at              timestamptz,
    paid_amount          numeric(12,2),
    yellow_form          boolean      NOT NULL DEFAULT false,
    referral_name        text         NOT NULL DEFAULT '',
    referral_grade       text         NOT NULL DEFAULT '',
    referral_amount      numeric(12,2) NOT NULL DEFAULT 0,
    referral_claimed     boolean      NOT NULL DEFAULT false,
    note_makeup          text         NOT NULL DEFAULT '',
    note_progress        text         NOT NULL DEFAULT '',
    note_relation        text         NOT NULL DEFAULT '',
    note_scores          text         NOT NULL DEFAULT '',
    note_schedule        text         NOT NULL DEFAULT '',
    note_other           text         NOT NULL DEFAULT '',
    updated_at           timestamptz  NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers (phone);
  CREATE INDEX IF NOT EXISTS idx_customers_type ON customers (resource_type);

  ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS customers_read_team ON customers;
  CREATE POLICY customers_read_team ON customers FOR SELECT USING (is_viewer());
  DROP POLICY IF EXISTS customers_insert_team ON customers;
  CREATE POLICY customers_insert_team ON customers FOR INSERT WITH CHECK (is_editor());
  DROP POLICY IF EXISTS customers_update_team ON customers;
  CREATE POLICY customers_update_team ON customers FOR UPDATE USING (is_editor()) WITH CHECK (is_editor());
  DROP POLICY IF EXISTS customers_delete_team ON customers;
  CREATE POLICY customers_delete_team ON customers FOR DELETE USING (is_editor());

  GRANT SELECT ON customers TO anon;
  GRANT SELECT, INSERT, UPDATE, DELETE ON customers TO authenticated;
  GRANT USAGE, SELECT ON SEQUENCE customers_id_seq TO authenticated;
END
$ddl$;


-- ⑤ 日常工作（同一标题允许重复，不建唯一索引）
DO $ddl$
BEGIN
  CREATE TABLE IF NOT EXISTS daily_tasks (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id    text        DEFAULT auth.uid(),
    owner_name  text,
    last_editor text        NOT NULL DEFAULT '',
    title       text        NOT NULL,
    priority    text        NOT NULL DEFAULT 'mid' CHECK (priority IN ('high','mid','low')),
    due_at      timestamptz NOT NULL,
    status      text        NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','done')),
    done_at     timestamptz,
    remark      text        NOT NULL DEFAULT '',
    created_by  text        NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_due ON daily_tasks (due_at);

  ALTER TABLE daily_tasks ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS daily_tasks_read_team ON daily_tasks;
  CREATE POLICY daily_tasks_read_team ON daily_tasks FOR SELECT USING (is_viewer());
  DROP POLICY IF EXISTS daily_tasks_insert_team ON daily_tasks;
  CREATE POLICY daily_tasks_insert_team ON daily_tasks FOR INSERT WITH CHECK (is_editor());
  DROP POLICY IF EXISTS daily_tasks_update_team ON daily_tasks;
  CREATE POLICY daily_tasks_update_team ON daily_tasks FOR UPDATE USING (is_editor()) WITH CHECK (is_editor());
  DROP POLICY IF EXISTS daily_tasks_delete_team ON daily_tasks;
  CREATE POLICY daily_tasks_delete_team ON daily_tasks FOR DELETE USING (is_editor());

  GRANT SELECT ON daily_tasks TO anon;
  GRANT SELECT, INSERT, UPDATE, DELETE ON daily_tasks TO authenticated;
  GRANT USAGE, SELECT ON SEQUENCE daily_tasks_id_seq TO authenticated;
END
$ddl$;


-- ⑥ 合同价目（T9：一方案一行）：唯一键 年份+年级+方案名称
--    旧结构（年份+年级+阶段+方案 的细粒度行）已于 T9 迁移时 DROP 重建。
--    stages 为 jsonb 数组，每项 { stage, sessions, material_fee }：
--      stage         A / B / C / D（由前端校验去重与排序）
--      sessions      该阶段具体报读次数（1–200）
--      material_fee  该阶段「单季度 · 单科目」资料费（可为 0，永不参与优惠）
--    T11 增列 remark（方案备注，选填 ≤200 字）：非破坏性 ALTER，RLS / GRANT 不变。
DO $ddl$
BEGIN
  CREATE TABLE IF NOT EXISTS contract_prices (
    id             bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id       text          DEFAULT auth.uid(),
    owner_name     text,
    last_editor    text          NOT NULL DEFAULT '',
    year           integer       NOT NULL CHECK (year BETWEEN 2000 AND 2100),
    grade          text          NOT NULL,
    plan_name      text          NOT NULL CONSTRAINT ck_prices_plan_name_len
                                 CHECK (length(btrim(plan_name)) BETWEEN 1 AND 20),
    unit_price     numeric(12,2) NOT NULL CHECK (unit_price > 0),
    stages         jsonb         NOT NULL DEFAULT '[]'::jsonb,
    discount_type  text          NOT NULL DEFAULT 'none'
                                 CHECK (discount_type IN ('none','pct','amount')),
    -- pct：折扣系数（0.85 = 85 折）；amount：减免金额（元）
    discount_value numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount_value >= 0),
    -- T11：方案备注（选填，≤200 字，由前端校验；展示在价目列表与合同明细单）
    remark         text          NOT NULL DEFAULT '',
    created_at     timestamptz   NOT NULL DEFAULT now(),
    updated_at     timestamptz   NOT NULL DEFAULT now()
  );
  -- 已存在的库就地补列（幂等）
  ALTER TABLE contract_prices ADD COLUMN IF NOT EXISTS remark text NOT NULL DEFAULT '';
  CREATE UNIQUE INDEX IF NOT EXISTS uk_prices_key ON contract_prices (year, grade, plan_name);
  CREATE INDEX IF NOT EXISTS idx_prices_grade ON contract_prices (year, grade);

  ALTER TABLE contract_prices ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS contract_prices_read_team ON contract_prices;
  CREATE POLICY contract_prices_read_team ON contract_prices FOR SELECT USING (is_viewer());
  DROP POLICY IF EXISTS contract_prices_insert_team ON contract_prices;
  CREATE POLICY contract_prices_insert_team ON contract_prices FOR INSERT WITH CHECK (is_editor());
  DROP POLICY IF EXISTS contract_prices_update_team ON contract_prices;
  CREATE POLICY contract_prices_update_team ON contract_prices FOR UPDATE USING (is_editor()) WITH CHECK (is_editor());
  DROP POLICY IF EXISTS contract_prices_delete_team ON contract_prices;
  CREATE POLICY contract_prices_delete_team ON contract_prices FOR DELETE USING (is_editor());

  GRANT SELECT ON contract_prices TO anon;
  GRANT SELECT, INSERT, UPDATE, DELETE ON contract_prices TO authenticated;
  GRANT USAGE, SELECT ON SEQUENCE contract_prices_id_seq TO authenticated;
END
$ddl$;


-- ⑦ 合同（科目行内嵌 items jsonb 快照）：唯一键 姓名+年级
DO $ddl$
BEGIN
  CREATE TABLE IF NOT EXISTS contracts (
    id                bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id          text          DEFAULT auth.uid(),
    owner_name        text,
    last_editor       text          NOT NULL DEFAULT '',
    stu_name          text          NOT NULL,
    grade             text          NOT NULL,
    year              integer       NOT NULL,
    plan              text          NOT NULL,
    items             jsonb         NOT NULL DEFAULT '[]'::jsonb,  -- [{stage,subject,unitPrice,sessions}]
    original_amount   numeric(12,2) NOT NULL DEFAULT 0,
    discount_type     text          NOT NULL DEFAULT 'none',       -- none|pct|amount
    discount_value    numeric(12,2) NOT NULL DEFAULT 0,
    discount_amount   numeric(12,2) NOT NULL DEFAULT 0,
    material_amount   numeric(12,2) NOT NULL DEFAULT 0,
    account_deduction numeric(12,2) NOT NULL DEFAULT 0,
    payable_amount    numeric(12,2) NOT NULL DEFAULT 0,
    balance_remain    numeric(12,2) NOT NULL DEFAULT 0,
    created_at        timestamptz   NOT NULL DEFAULT now(),
    updated_at        timestamptz   NOT NULL DEFAULT now(),
    created_by        text          NOT NULL DEFAULT ''
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uk_contracts_key ON contracts (stu_name, grade);

  ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS contracts_read_team ON contracts;
  CREATE POLICY contracts_read_team ON contracts FOR SELECT USING (is_viewer());
  DROP POLICY IF EXISTS contracts_insert_team ON contracts;
  CREATE POLICY contracts_insert_team ON contracts FOR INSERT WITH CHECK (is_editor());
  DROP POLICY IF EXISTS contracts_update_team ON contracts;
  CREATE POLICY contracts_update_team ON contracts FOR UPDATE USING (is_editor()) WITH CHECK (is_editor());
  DROP POLICY IF EXISTS contracts_delete_team ON contracts;
  CREATE POLICY contracts_delete_team ON contracts FOR DELETE USING (is_editor());

  GRANT SELECT ON contracts TO anon;
  GRANT SELECT, INSERT, UPDATE, DELETE ON contracts TO authenticated;
  GRANT USAGE, SELECT ON SEQUENCE contracts_id_seq TO authenticated;
END
$ddl$;


-- 表注释（便于在云控制台辨认，可重复执行）
COMMENT ON TABLE students IS '学生档案；唯一键 姓名+学校+年级；与 score_records 按 姓名+学校 弱关联（只读）';
COMMENT ON TABLE classes IS '班级；唯一键 班级名称（全局唯一）；上课时间存 schedules jsonb';
COMMENT ON TABLE class_members IS '学生↔班级多对多桥表；唯一键 班级+学生；无外键，一致性由应用层双写维护';
COMMENT ON TABLE customers IS '客户资源；与学生表零关联（不建外键、不做查重联动）；转介绍内嵌 4 列；不建唯一索引（同手机号允许多次咨询）';
COMMENT ON TABLE daily_tasks IS '日常工作待办；周期归属一律用 due_at；允许同标题重复';
COMMENT ON TABLE contract_prices IS '合同价目（T9 一方案一行）；唯一键 年份+年级+方案名称；stages jsonb 存阶段次数与单科资料费；合同签订时快照至 contracts.items';
COMMENT ON COLUMN contract_prices.stages IS '阶段配置 jsonb：[{stage:"A",sessions:7,material_fee:100}]，阶段不重复、次数 1-200、资料费可 0';
COMMENT ON COLUMN contract_prices.discount_value IS '优惠值：discount_type=pct 时为折扣系数（0.85=85折）；amount 时为减免金额（元）';
COMMENT ON COLUMN contract_prices.remark IS 'T11 方案备注（选填，≤200 字，前端校验长度）；展示在价目列表与合同明细单，并随 items.plans[].remark 快照进合同';
COMMENT ON TABLE contracts IS '合同台账；唯一键 姓名+年级；科目行内嵌 items jsonb 快照，金额为签订时快照';
COMMENT ON COLUMN contracts.plan IS '报读方案名称；T11 起多方案用 + 拼接（如「寒春连报+暑期班」）';
COMMENT ON COLUMN contracts.items IS '明细快照：T11 为 {plans:[{planName,unit_price,stages,subjects,discount,subjectRows,stageMaterial,original,discountAmount,tuition,materialAmount,remark,lines}],plans 同级的 planName/plan/stages/lines 为兼容冗余}；T9 为 {plan,planName,stages,lines,...}；更早为 {lines}';
