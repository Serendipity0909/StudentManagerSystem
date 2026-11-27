-- ============================================================================
-- ARCH v4 · 云端 DDL：客户意向程度 + 结停课资源
-- 文件：docs/ddl-v4-customer-intent-stopres.sql
-- 唯一权威契约：docs/ARCH-v4-customer-intent-stopres.md §5（本文件 SQL 与之逐字一致）
-- ============================================================================
-- ⚠️⚠️ R4 硬裁决：本脚本「只写不执行」⚠️⚠️
--   · 当前阶段 = 本地实现 + 全量测试（假云端）；生产库不建表、不加列。
--   · 工程师只做静态核对（V-G1 7 项，见本文件尾部注释），
--     禁止连生产库、禁止执行任何一条 DDL / 触发器 / 回填。
--   · 生产加列 / 建表与发布上线须用户后续单独确认，确认后方可逐块执行。
--   · 每个对象封成独立 DO $ddl$ ... END $ddl$; 块，可单条执行、可重复执行（幂等），
--     沿用 docs/ddl-v2.sql 约定。
-- ============================================================================

-- ① customers 增列（非破坏性；存量行自动取 ''，绝不 UPDATE 回填）
DO $ddl$ BEGIN
  ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS intent_level text NOT NULL DEFAULT '';
END $ddl$;

-- ② 新表 24 列（18 业务 + 6 系统），不建任何 UNIQUE / INDEX / FOREIGN KEY
DO $ddl$ BEGIN
  CREATE TABLE IF NOT EXISTS stop_resources (
    id                bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id          text         DEFAULT auth.uid(),
    owner_name        text,
    last_editor       text         NOT NULL DEFAULT '',
    stu_name          text         NOT NULL,
    phone             text         NOT NULL,
    grade             text         NOT NULL DEFAULT '',
    school            text         NOT NULL,
    stop_date         timestamptz  NOT NULL,
    resource_type     text         NOT NULL,
    refund_reason     text         NOT NULL DEFAULT '',
    nonrenew_reason   text         NOT NULL DEFAULT '',
    refund_subjects   text         NOT NULL DEFAULT '',
    end_subjects      text         NOT NULL DEFAULT '',
    teacher           text         NOT NULL,
    followup_intent   text         NOT NULL,
    refund_amount     numeric(12,2),
    parent_confirmed  boolean      NOT NULL DEFAULT false,
    refund_applied    boolean      NOT NULL DEFAULT false,
    refund_apply_at   timestamptz,
    refund_arrived    boolean      NOT NULL DEFAULT false,
    refund_arrived_at timestamptz,
    created_at        timestamptz  NOT NULL DEFAULT now(),
    updated_at        timestamptz  NOT NULL DEFAULT now()
  );
END $ddl$;

-- ③ RLS 4 条（复制 customers 同款）
DO $ddl$ BEGIN
  ALTER TABLE stop_resources ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS stop_resources_read_team ON stop_resources;
  CREATE POLICY stop_resources_read_team ON stop_resources FOR SELECT USING (is_viewer());
  DROP POLICY IF EXISTS stop_resources_insert_team ON stop_resources;
  CREATE POLICY stop_resources_insert_team ON stop_resources FOR INSERT WITH CHECK (is_editor());
  DROP POLICY IF EXISTS stop_resources_update_team ON stop_resources;
  CREATE POLICY stop_resources_update_team ON stop_resources FOR UPDATE USING (is_editor()) WITH CHECK (is_editor());
  DROP POLICY IF EXISTS stop_resources_delete_team ON stop_resources;
  CREATE POLICY stop_resources_delete_team ON stop_resources FOR DELETE USING (is_editor());
END $ddl$;

-- ④ GRANT 2 行 + 序列 USAGE（漏则 insert 报 42501）
DO $ddl$ BEGIN
  GRANT SELECT ON stop_resources TO anon;
  GRANT SELECT, INSERT, UPDATE, DELETE ON stop_resources TO authenticated;
  GRANT USAGE, SELECT ON SEQUENCE stop_resources_id_seq TO authenticated;
END $ddl$;

-- ⑤ COMMENT
DO $ddl$ BEGIN
  COMMENT ON TABLE stop_resources IS
    '结停课资源；与客户表零关联、不建唯一索引、同一人可多条；筛选按 stop_date 本地年月';
  COMMENT ON COLUMN customers.intent_level IS
    '意向程度：低/中/高；存量行为空串表示未填写，不回填；新增与编辑提交时强制必选';
END $ddl$;

-- ============================================================================
-- V-G1 静态核对清单（工程师逐项核对；不执行、不连库、不上生产）
-- ① customers 既有列零改写：全脚本仅 1 条 ADD COLUMN IF NOT EXISTS，无任何 UPDATE；
--    既有列（ddl-v2.sql:154-187，实测 32 列）的值 / 索引 / RLS / GRANT / COMMENT 均不动。
-- ② stop_resources 恰好 24 列（18 业务 + 6 系统），列序 / 类型 / NOT NULL / DEFAULT
--    与 ARCH-v4 §2.2 字段表逐行一致。
-- ③ 无 UNIQUE / INDEX / FOREIGN KEY（仅 id 主键）；无视图 / 触发器 / 跨表引用。
-- ④ RLS 4 条：ENABLE ROW LEVEL SECURITY + 4 policy
--    stop_resources_{read,insert,update,delete}_team，谓词 is_viewer() / is_editor()，
--    与 docs/ddl-v2.sql 同款命名。
-- ⑤ GRANT 2 行（anon SELECT / authenticated SELECT,INSERT,UPDATE,DELETE）+ 序列
--    USAGE, SELECT ON SEQUENCE stop_resources_id_seq TO authenticated 齐全
--    （漏则 insert 报 42501；序列名由 GENERATED ALWAYS AS IDENTITY 自动生成）。
-- ⑥ COMMENT：表注释含「零关联」；customers.intent_level 列注释含「不回填 / 强制必选」。
-- ⑦ 每个 DO 块以 IF NOT EXISTS / DROP POLICY IF EXISTS 包裹，可独立重复执行（幂等）。
-- ============================================================================
-- 回滚方案（仅本地测试库；R4 生产库从未执行过任何 DDL，生产侧无需回滚）
--   DROP TABLE IF EXISTS stop_resources;
--   ALTER TABLE customers DROP COLUMN IF EXISTS intent_level;
-- ============================================================================
