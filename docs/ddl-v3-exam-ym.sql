-- ============================================================
-- v3 增量 DDL + 42 行一次性定点回填（score_records）
-- 执行人：team-lead（主理人）  |  时点：2026-11-20
-- 状态：**已执行并通过全部验收**（见 docs/baseline-score.txt「v3 新基线」章节）
-- 权威基线：docs/baseline-score.txt（v3 新基线章节，口径 A + C 并用）
-- 采集底稿：docs/baseline-score-42.txt（非权威） / docs/backup-pre-v3.json（三列逐行）
-- 红线：既有 16 列值零改写、42 行零丢失、唯一索引零改动
--
-- 实测结果（2026-11-20，TimeZone=PRC）：
--   口径 A  n=42 fp=d08aab5b7f0aa8028873f67bd0248859（前后逐字节一致）
--   口径 C  n=42 fp=4120b89db2e0df7be40c564f7e41b70b（前后逐字节一致）
--   三列    fp3=120df1f4d7924b7dd1adeaff47beb3d5（与 backup 一致）
--   分布    2026-10 = 41 条、2026-11 = 1 条；非法年月 = 0
--   结构    17 列、触发器 0、RLS 4 条、索引 2 个（均不变）
--
-- 前置预检（均已实测通过，勿跳过）：
--   pg_trigger 自定义触发器 = 0；无列级 REVOKE；
--   ADD COLUMN 后 exam_ym 自动继承表级 GRANT（authenticated: INSERT/UPDATE/SELECT）；
--   RLS 4 条策略不变；score_records_unique_stu 不变。
--
-- ⚠ 口径 C 规范形式唯一：下方 concat_ws('|', ...) + string_agg(t, E'\n' ORDER BY t)。
--   任何 concat_ws('~') / string_agg(k,'|') 变体会得到另一个 md5（实测
--   e921c0705b192253d4ebaa31d73518ed），不同拼串口径不可互比，照抄会假失败误触发回滚。
-- ============================================================

-- 1) 唯一允许的表结构变更：新增可空列，无默认值 / 无约束 / 无索引
ALTER TABLE score_records
  ADD COLUMN IF NOT EXISTS exam_ym TEXT;

-- 2) 定点回填（幂等，WHERE exam_ym IS NULL，仅 SET exam_ym 一列）
--    规则：exam 文本抓「N月」得月份 + entered_at 年份；
--          抓不到月份 → 用 entered_at 的年月兜底；
--          跨年补录修正：exam 月份 > entered_at 月份 + 1 → 年份 -1
WITH calc AS (
  SELECT id, exam, entered_at,
         NULLIF(substring(exam FROM '([0-9]{1,2})月'), '')::int AS m,
         substring(entered_at FROM 1 FOR 4)::int                 AS y,
         substring(entered_at FROM 6 FOR 2)::int                 AS em
  FROM score_records
  WHERE exam_ym IS NULL
), resolved AS (
  SELECT id,
         CASE WHEN m IS NULL OR m < 1 OR m > 12 THEN lpad(em::text, 2, '0')
              ELSE lpad(m::text, 2, '0') END AS mm,
         CASE WHEN m IS NULL OR m < 1 OR m > 12 THEN y
              WHEN m > em + 1 THEN y - 1
              ELSE y END                     AS yy
  FROM calc
)
UPDATE score_records s
SET exam_ym = r.yy || '-' || r.mm
FROM resolved r
WHERE s.id = r.id AND s.exam_ym IS NULL;

-- 3) 回填后校验（期望：2026-10 = 41 条、2026-11 = 1 条）
SELECT exam_ym, count(*) FROM score_records GROUP BY 1 ORDER BY 1;

-- 3b) 非法年月必须为 0
SELECT count(*) AS bad_ym FROM score_records
 WHERE exam_ym IS NOT NULL AND exam_ym !~ '^[0-9]{4}-(0[1-9]|1[0-2])$';

-- 3c) 分布明细留证（待明确 #5：出现异常行时先交 team-lead 确认再 COMMIT）
SELECT exam, entered_at, exam_ym FROM score_records ORDER BY exam_ym, exam, id;

-- 3d) 结构 / 权限 / 触发器 / RLS 不变
SELECT (SELECT count(*) FROM pg_trigger WHERE tgrelid='score_records'::regclass AND NOT tgisinternal) AS custom_triggers,
       (SELECT count(*) FROM pg_policies WHERE tablename='score_records') AS rls_policies,
       (SELECT count(*) FROM pg_indexes WHERE tablename='score_records') AS indexes,
       (SELECT count(*) FROM information_schema.columns WHERE table_name='score_records') AS cols;
SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) FROM
  information_schema.column_privileges
 WHERE table_name='score_records' AND column_name='exam_ym' GROUP BY 1 ORDER BY 1;

-- 3e) 口径 A（G1 权威，拼串不含 exam_ym，期望 n=42 / fp=d08aab5b7f0aa8028873f67bd0248859）
SELECT count(*) AS n, md5(string_agg(k,'|' ORDER BY k)) AS fp_A FROM (
  SELECT stu_name||'~'||coalesce(school,'')||'~'||coalesce(class_name,'')||'~'||coalesce(exam,'')||'~'
      ||coalesce(scores::text,'')||'~'||coalesce(ranks::text,'')||'~'
      ||coalesce(total_rank::text,'')||'~'||coalesce(entered_at::text,'') AS k
  FROM score_records
) t;

-- 4) 口径 C 全 16 列指纹复测（V-H1/V-H2 强制补充，期望 n=42 / fp=4120b89db2e0df7be40c564f7e41b70b）
SELECT count(*) AS n, md5(string_agg(t, E'\n' ORDER BY t)) AS fp
FROM (
  SELECT concat_ws('|', id::text, coalesce(owner_id,''), coalesce(owner_name,''),
                        coalesce(last_editor,''), coalesce(rec_id,''), coalesce(stu_name,''),
                        coalesce(school,''), coalesce(class_name,''), coalesce(exam,''),
                        coalesce(scores::text,''), coalesce(ranks::text,''),
                        coalesce(total::text,''), coalesce(total_rank::text,''),
                        coalesce(entered_at,''), coalesce(created_at::text,''),
                        coalesce(updated_at::text,'')) AS t
  FROM score_records
) s;

-- 5) V-H2 三列专项（期望 fp3=120df1f4d7924b7dd1adeaff47beb3d5，与 backup-pre-v3.json 逐行一致）
SELECT md5(string_agg(t, E'\n' ORDER BY id)) AS fp3 FROM (
  SELECT id, concat_ws('|', id::text, coalesce(entered_at,''),
                            coalesce(updated_at::text,''), coalesce(last_editor,'')) AS t
  FROM score_records
) s;
-- 逐行明细（与 backup-pre-v3.json 的 three_cols 比对）
SELECT id, entered_at, updated_at::text AS updated_at, last_editor
  FROM score_records ORDER BY id;

-- 回滚方案（仅当上述任一校验失败时执行）
-- UPDATE score_records SET exam_ym = NULL;   -- 清空回填值（不删列，保留结构）
-- ALTER TABLE score_records DROP COLUMN IF EXISTS exam_ym;
