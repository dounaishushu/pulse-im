<?php

namespace app\Service;

use RuntimeException;
use think\facade\Db;

final class WorkTaskService
{
    public const MAX_QUESTIONS_PER_TASK = 1000;

    public function adminTasks(array $filters): array
    {
        $page = max(1, (int) ($filters['page'] ?? 1));
        $size = min(100, max(1, (int) ($filters['size'] ?? 10)));
        $query = Db::name('work_tasks')->order(['sort_order' => 'asc', 'id' => 'desc']);
        $key = trim((string) ($filters['key'] ?? ''));
        $name = trim((string) ($filters['name'] ?? ''));
        $status = trim((string) ($filters['status'] ?? ''));
        if ($key !== '') $query->whereLike('task_key', '%' . addcslashes($key, '%_') . '%');
        if ($name !== '') $query->whereLike('name', '%' . addcslashes($name, '%_') . '%');
        if (in_array($status, ['enabled', 'disabled'], true)) $query->where('status', $status);
        $rows = $query->paginate(['list_rows' => $size, 'page' => $page]);
        return ['items' => array_map(fn (array $row): array => $this->formatTask($row), $this->withTodayCounts($rows->items())), 'total' => $rows->total(), 'page' => $rows->currentPage(), 'size' => $size];
    }

    public function saveTask(array $payload): array
    {
        $id = (int) ($payload['id'] ?? 0);
        $key = trim((string) ($payload['task_key'] ?? ''));
        $name = trim((string) ($payload['name'] ?? ''));
        $openTime = trim((string) ($payload['open_time'] ?? ''));
        $description = trim(str_replace(["\r\n", "\r"], "\n", (string) ($payload['description'] ?? '')));
        $estimated = (int) ($payload['estimated_minutes'] ?? 0);
        $questionCount = (int) ($payload['question_count'] ?? 0);
        $sort = (int) ($payload['sort_order'] ?? 0);
        $status = (string) ($payload['status'] ?? 'enabled');
        $intern = $this->decimal($payload['intern_unit_price'] ?? 0, '实习员工单价');
        $formal = $this->decimal($payload['formal_unit_price'] ?? 0, '正式员工单价');
        if (!preg_match('/^[A-Za-z][A-Za-z0-9_]{0,63}$/D', $key)) throw new RuntimeException('任务键只能使用字母、数字和下划线，且必须以字母开头。');
        if ($name === '' || mb_strlen($name) > 120) throw new RuntimeException('任务名称不能为空且最多120个字。');
        if (!preg_match('/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/', $openTime)) throw new RuntimeException('开放时间格式不正确。');
        if (strlen($openTime) === 5) $openTime .= ':00';
        if ($estimated < 1 || $estimated > 1440) throw new RuntimeException('预计用时必须在1至1440分钟之间。');
        if ($questionCount < 1 || $questionCount > self::MAX_QUESTIONS_PER_TASK) throw new RuntimeException('题目数量必须在1至1000之间。');
        if ($questionCount < 2 || $questionCount % 2 !== 0) throw new RuntimeException('题目数量必须是偶数，系统会按正确答案和错误答案各一半随机抽取。');
        if (mb_strlen($description) > 5000) throw new RuntimeException('任务描述最多5000个字。');
        if (!in_array($status, ['enabled', 'disabled'], true)) throw new RuntimeException('任务状态不正确。');
        WorkTaskMoney::assertMaximum($questionCount, $intern);
        WorkTaskMoney::assertMaximum($questionCount, $formal);
        return Db::transaction(function () use ($id, $key, $name, $openTime, $estimated, $description, $intern, $formal, $questionCount, $sort, $status): array {
        if ($id > 0) {
            if (!Db::name('work_tasks')->where('id', $id)->lock(true)->find()) throw new RuntimeException('任务不存在。');
            $todayCount = (int) Db::name('work_task_daily_questions')->where('task_id', $id)->where('task_date', $this->beijingDate())->lock(true)->value('total_count');
            if ($todayCount > 0) { WorkTaskMoney::assertMaximum($todayCount, $intern); WorkTaskMoney::assertMaximum($todayCount, $formal); }
        }
        if ($status === 'enabled') $this->validateQuestionPool($questionCount);
        $now = date('Y-m-d H:i:s');
        $data = ['task_key' => $key, 'name' => $name, 'open_time' => $openTime, 'estimated_minutes' => $estimated, 'description' => $description, 'intern_unit_price' => $intern, 'formal_unit_price' => $formal, 'question_count' => $questionCount, 'sort_order' => $sort, 'status' => $status, 'updated_at' => $now];
        if ($id > 0) {
            $existing = Db::name('work_tasks')->where('id', $id)->find();
            if (!$existing) throw new RuntimeException('任务不存在。');
            if (Db::name('work_tasks')->where('task_key', $key)->where('id', '<>', $id)->find()) throw new RuntimeException('任务键已经存在。');
            Db::name('work_tasks')->where('id', $id)->update($data);
        } else {
            if (Db::name('work_tasks')->where('task_key', $key)->find()) throw new RuntimeException('任务键已经存在。');
            $data['created_at'] = $now;
            $id = (int) Db::name('work_tasks')->insertGetId($data);
        }
        return $this->formatTask($this->withTodayCounts([(array) Db::name('work_tasks')->where('id', $id)->find()], true)[0]);
        });
    }

    public function deleteTasks(array $ids): int
    {
        $ids = array_values(array_unique(array_filter(array_map('intval', $ids), static fn (int $id): bool => $id > 0)));
        if ($ids === []) throw new RuntimeException('请选择要删除的任务。');
        sort($ids, SORT_NUMERIC);
        return Db::transaction(function () use ($ids): int {
            // Starting a first record uses the same parent lock. A stale zero-count must never
            // permit a cascading delete after that first record commits.
            Db::name('work_tasks')->whereIn('id', $ids)->order('id')->lock(true)->column('id');
            if (Db::name('work_task_records')->whereIn('task_id', $ids)->field('id')->lock(true)->find()) throw new RuntimeException('已有作业记录的任务不能删除，请先停用任务。');
            return (int) Db::name('work_tasks')->whereIn('id', $ids)->delete();
        });
    }

    public function setStatus(int $id, string $status): array
    {
        if ($id <= 0) throw new RuntimeException('任务不存在。');
        if (!in_array($status, ['enabled', 'disabled'], true)) throw new RuntimeException('任务状态不正确。');
        return Db::transaction(function () use ($id, $status): array {
        $task = Db::name('work_tasks')->where('id', $id)->lock(true)->find();
        if (!$task) throw new RuntimeException('任务不存在。');
        if ($status === 'enabled' && ((int) $task['question_count'] < 2 || (int) $task['question_count'] % 2 !== 0)) throw new RuntimeException('题目数量必须是偶数，系统会按正确答案和错误答案各一半随机抽取。');
        if ($status === 'enabled') {
            $task = $this->withTodayCounts([$task], true)[0];
            foreach (array_unique([(int) $task['question_count'], (int) $task['today_question_count']]) as $count) {
                WorkTaskMoney::assertMaximum($count, $task['intern_unit_price']); WorkTaskMoney::assertMaximum($count, $task['formal_unit_price']);
            }
            $this->validateQuestionPool((int) $task['question_count']);
        }
        Db::name('work_tasks')->where('id', $id)->update(['status' => $status, 'updated_at' => date('Y-m-d H:i:s')]);
        return $this->formatTask($this->withTodayCounts([(array) Db::name('work_tasks')->where('id', $id)->find()], true)[0]);
        });
    }

    public function taskCode(int $taskId, string $date = '', bool $regenerate = false): array
    {
        $date = $date !== '' ? $date : $this->beijingDate();
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/D', $date) || $date < '1000-01-01' || !checkdate((int) substr($date, 5, 2), (int) substr($date, 8, 2), (int) substr($date, 0, 4))) throw new RuntimeException('日期格式不正确。');
        return Db::transaction(function () use ($taskId, $date, $regenerate): array {
            // Serialize first creation and explicit regeneration on the parent,
            // including callers already holding it in an outer task transaction.
            $task = Db::name('work_tasks')->where('id', $taskId)->lock(true)->find();
            if (!$task) throw new RuntimeException('任务不存在。');
            $existing = Db::name('work_task_codes')->where(['task_id' => $taskId, 'task_date' => $date])->lock(true)->find();
            $code = (string) ($existing['code'] ?? '');
            if ($regenerate || !preg_match('/^\d{6}$/D', $code)) {
                do {
                    $next = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
                } while ($next === $code);
                $now = date('Y-m-d H:i:s');
                if ($existing) {
                    Db::name('work_task_codes')->where('id', (int) $existing['id'])->update(['code' => $next, 'updated_at' => $now]);
                } else {
                    Db::name('work_task_codes')->insert(['task_id' => $taskId, 'task_date' => $date, 'code' => $next, 'created_at' => $now, 'updated_at' => $now]);
                }
                $code = $next;
            }
            return ['task_id' => $taskId, 'task_name' => (string) $task['name'], 'date' => $date, 'code' => $code, 'regenerated' => $regenerate];
        });
    }

    /** All created tasks, including disabled and not-yet-open tasks; never paginated. */
    public function dailyTaskCodes(): array
    {
        $date = $this->beijingDate();
        return Db::transaction(function () use ($date): array {
            // The same ascending parent lock order is used by concurrent batches.
            $tasks = Db::name('work_tasks')->field('id,name,status,sort_order')->order('id', 'asc')->lock(true)->select()->toArray();
            if ($tasks === []) return ['date' => $date, 'items' => [], 'total' => 0];
            $codes = Db::name('work_task_codes')->where('task_date', $date)->whereIn('task_id', array_column($tasks, 'id'))
                ->order('task_id', 'asc')->lock(true)->column('code', 'task_id');
            usort($tasks, static fn (array $a, array $b): int => ((int) $a['sort_order'] <=> (int) $b['sort_order']) ?: ((int) $b['id'] <=> (int) $a['id']));
            $items = [];
            foreach ($tasks as $task) {
                $id = (int) $task['id']; $code = (string) ($codes[$id] ?? '');
                if (!preg_match('/^\d{6}$/D', $code)) $code = $this->taskCode($id, $date, false)['code'];
                $items[] = ['task_id' => $id, 'task_name' => (string) $task['name'], 'code' => $code, 'status' => (string) $task['status']];
            }
            return ['date' => $date, 'items' => $items, 'total' => count($items)];
        });
    }

    private function beijingDate(): string
    {
        return $this->beijingNow()->format('Y-m-d');
    }

    private function beijingNow(): \DateTimeImmutable
    {
        return new \DateTimeImmutable('now', new \DateTimeZone('Asia/Shanghai'));
    }

    public function adminQuestions(array $filters): array
    {
        $page = max(1, (int) ($filters['page'] ?? 1));
        $size = min(100, max(1, (int) ($filters['size'] ?? 20)));
        $query = Db::name('work_questions')->order('id', 'desc');
        $uuid = trim((string) ($filters['uuid'] ?? ''));
        $answer = (string) ($filters['answer'] ?? '');
        if ($uuid !== '') $query->whereLike('question_uuid', '%' . addcslashes($uuid, '%_') . '%');
        if ($answer === '0' || $answer === '1') $query->where('correct_answer', (int) $answer);
        $rows = $query->paginate(['list_rows' => $size, 'page' => $page]);
        return ['items' => array_map(fn (array $row): array => $this->formatQuestion($row, true), $rows->items()), 'total' => $rows->total(), 'page' => $rows->currentPage(), 'size' => $size];
    }

    public function saveQuestion(array $payload, ?array $account = null): array
    {
        $id = (int) ($payload['id'] ?? 0);
        $uuid = trim((string) ($payload['question_uuid'] ?? ''));
        // CSV/XLSX URLs do not pass through JSON middleware; strip temporary media grants here too.
        $image = (new MediaAccessService())->canonicalUrl(trim((string) ($payload['image_url'] ?? '')));
        if ($account !== null) (new MediaAccessService())->assertAdminCanAttach($image, $account);
        $answer = $this->answerValue($payload['correct_answer'] ?? null);
        if ($id > 0) {
            $old = Db::name('work_questions')->where('id', $id)->find();
            if (!$old) throw new RuntimeException('题目不存在。');
            $uuid = (string) $old['question_uuid'];
        } elseif ($uuid === '') {
            $uuid = $this->uuid();
        }
        if (!preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i', $uuid)) throw new RuntimeException('题目UUID格式不正确。');
        if ($image === '' || mb_strlen($image) > 2048 || !preg_match('~^(https?://|/storage/)~i', $image)) throw new RuntimeException('图片地址必须是有效的HTTP地址或站内存储地址。');
        if ($answer === null) throw new RuntimeException('请选择正确答案。');
        $now = date('Y-m-d H:i:s');
        $data = ['question_uuid' => $uuid, 'image_url' => $image, 'correct_answer' => $answer, 'updated_at' => $now];
        if ($id > 0) Db::name('work_questions')->where('id', $id)->update($data);
        else { $data['created_at'] = $now; $id = (int) Db::name('work_questions')->insertGetId($data); }
        return $this->formatQuestion((array) Db::name('work_questions')->where('id', $id)->find(), true);
    }

    public function deleteQuestions(array $ids): int
    {
        $ids = array_values(array_unique(array_filter(array_map('intval', $ids), static fn (int $id): bool => $id > 0)));
        if ($ids === []) throw new RuntimeException('请选择要删除的题目。');
        return (int) Db::name('work_questions')->whereIn('id', $ids)->delete();
    }

    public function importQuestions(array $rows, ?array $account = null): array
    {
        if (count($rows) > WorkQuestionImporter::MAX_ROWS) throw new RuntimeException('每次最多导入10000道题。');
        // Check every reference before changing any row: an unauthorized attachment must not become
        // a readable question merely because another row in this import succeeded first.
        if ($account !== null) foreach ($rows as $row) {
            if (is_array($row)) (new MediaAccessService())->assertAdminCanAttach(trim((string) ($row['image_url'] ?? '')), $account);
        }
        $created = 0; $updated = 0; $errors = [];
        Db::transaction(function () use ($rows, $account, &$created, &$updated, &$errors): void {
            foreach ($rows as $index => $row) {
                try {
                    $payload = ['question_uuid' => $row['question_uuid'] ?? '', 'image_url' => $row['image_url'] ?? '', 'correct_answer' => $row['correct_answer'] ?? null];
                    $uuid = trim((string) $payload['question_uuid']);
                    if ($uuid !== '' && Db::name('work_questions')->where('question_uuid', $uuid)->find()) { $old = Db::name('work_questions')->where('question_uuid', $uuid)->find(); $payload['id'] = (int) $old['id']; $this->saveQuestion($payload, $account); $updated++; }
                    else { $this->saveQuestion($payload, $account); $created++; }
                } catch (\Throwable $error) {
                    $errors[] = ['row' => (int) ($row['_row'] ?? $index + 2), 'message' => $error->getMessage()];
                }
            }
        });
        return ['created' => $created, 'updated' => $updated, 'errors' => $errors];
    }

    public function userTasks(array $user): array
    {
        $rows = $this->withTodayCounts(Db::name('work_tasks')->where('status', 'enabled')->order(['sort_order' => 'asc', 'id' => 'desc'])->select()->toArray());
        $today = $this->beijingDate();
        $records = Db::name('work_task_records')->where('user_id', (int) $user['id'])->where('task_date', $today)->select()->toArray();
        // Old submitted records settle on the next mobile read as well.
        foreach ($records as &$record) {
            if ($record['status'] === 'pending_review') {
                $this->submitTask((int) $user['id'], (int) $record['id'], []);
                $record = Db::name('work_task_records')->where('id', (int) $record['id'])->find();
            }
        }
        unset($record);
        $byTask = []; foreach ($records as $record) $byTask[(int) $record['task_id']] = $record;
        $employeeType = (bool) Db::name('user_permissions')->where('user_id', (int) $user['id'])->value('formal_employee') ? 'formal' : 'intern';
        return ['date' => $today, 'employee_type' => $employeeType, 'items' => array_map(fn (array $task): array => $this->mobileTask($task, $byTask[(int) $task['id']] ?? null, $employeeType), $rows)];
    }

    public function startTask(int $userId, int $taskId, string $verificationCode = ''): array
    {
        return Db::transaction(function () use ($userId, $taskId, $verificationCode): array {
        $user = Db::name('users')->where('id', $userId)->lock(true)->find();
        if (!$user || $user['status'] !== 'active') throw new RuntimeException('当前账号无法开始任务。');
        $task = Db::name('work_tasks')->where('id', $taskId)->where('status', 'enabled')->lock(true)->find();
        if (!$task) throw new RuntimeException('任务不存在或已经停用。');
        $beijingNow = new \DateTimeImmutable('now', new \DateTimeZone('Asia/Shanghai'));
        if ($beijingNow->format('H:i:s') < (string) $task['open_time']) throw new RuntimeException('任务尚未开放，请到开放时间后再开始。');
        $today = $beijingNow->format('Y-m-d');
        $dailyCode = (string) $this->taskCode($taskId, $today)['code'];
        if (!preg_match('/^\d{6}$/D', trim($verificationCode)) || !hash_equals($dailyCode, trim($verificationCode))) {
            throw new RuntimeException('验证码不正确，请输入后台显示的每日验证码。');
        }
        $existing = Db::name('work_task_records')->where('user_id', $userId)->where('task_id', $taskId)->where('task_date', $today)->find();
        if ($existing) return $existing['status'] === 'pending_review'
            ? $this->submitTask($userId, (int) $existing['id'], [])
            : $this->recordPayload($this->joinedRecord((int) $existing['id']), true);
        // Only the administrator's current switch determines a new record's role and price.
        // Existing records above retain the role and price captured when work began.
        $type = (bool) Db::name('user_permissions')->where('user_id', $userId)->lock(true)->value('formal_employee') ? 'formal' : 'intern';
        $unitPrice = (string) ($type === 'formal' ? $task['formal_unit_price'] : $task['intern_unit_price']);
        WorkTaskMoney::assertMaximum((int) $task['question_count'], $unitPrice);
        $dailyBatch = $this->dailyQuestionBatch((int) $task['id'], $today, (int) $task['question_count']);
        $questions = $this->questionsForDailyBatch($dailyBatch);
        WorkTaskMoney::assertMaximum(count($questions), $unitPrice);
        // 快照需要保留标准答案，移动端返回时再由 recordPayload() 隐藏，
        // 这样题库后续修改也不会影响历史作业的批改。
        $snapshot = array_map(fn (array $question): array => $this->formatQuestion($question, true), $questions);
        $now = date('Y-m-d H:i:s');
        $id = (int) Db::name('work_task_records')->insertGetId(['user_id' => $userId, 'task_id' => $taskId, 'task_date' => $today, 'employee_type' => $type, 'status' => 'in_progress', 'start_at' => $now, 'duration_seconds' => 0, 'total_questions' => count($snapshot), 'correct_count' => 0, 'wrong_count' => 0, 'unit_price' => $unitPrice, 'wage' => 0, 'answers_json' => '{}', 'question_snapshot_json' => json_encode($snapshot, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), 'review_results_json' => '{}', 'review_note' => '', 'created_at' => $now, 'updated_at' => $now]);
        return $this->recordPayload($this->joinedRecord($id), true);
        });
    }

    public function taskRecord(int $userId, int $recordId): array
    {
        $record = Db::name('work_task_records')->where('id', $recordId)->where('user_id', $userId)->find();
        if (!$record) throw new RuntimeException('作业记录不存在。');
        if ($record['status'] === 'pending_review') return $this->submitTask($userId, $recordId, []);
        return $this->recordPayload($this->joinedRecord($recordId), true);
    }

    public function saveAnswers(int $userId, int $recordId, array $answers): array
    {
        return Db::transaction(function () use ($userId, $recordId, $answers): array {
            $record = Db::name('work_task_records')->where('id', $recordId)->where('user_id', $userId)->lock(true)->find();
            if (!$record) throw new RuntimeException('作业记录不存在。');
            if ($record['status'] !== 'in_progress') throw new RuntimeException('作业已经提交，不能修改答案。');
            $normalized = $this->normalizeAnswers($this->jsonArray($record['question_snapshot_json']), $answers, false);
            $merged = array_replace($this->jsonMap($record['answers_json']), $normalized);
            Db::name('work_task_records')->where('id', $recordId)->update(['answers_json' => json_encode((object) $merged, JSON_UNESCAPED_UNICODE), 'updated_at' => date('Y-m-d H:i:s')]);
            return $this->recordPayload($this->joinedRecord($recordId), true);
        });
    }

    public function submitTask(int $userId, int $recordId, array $answers): array
    {
        return Db::transaction(function () use ($userId, $recordId, $answers): array {
        $record = Db::name('work_task_records')->where('id', $recordId)->where('user_id', $userId)->lock(true)->find();
        if (!$record) throw new RuntimeException('作业记录不存在。');
        if ($record['status'] === 'reviewed') return $this->recordPayload($this->joinedRecord($recordId), true);
        if ($record['status'] === 'pending_review') return $this->autoReviewRecord($record);
        if ($record['status'] !== 'in_progress') throw new RuntimeException('作业状态异常，请联系管理员。');
        $snapshot = $this->jsonArray($record['question_snapshot_json']);
        $normalized = $this->normalizeAnswers($snapshot, array_replace($this->jsonMap($record['answers_json']), $answers), true);
        $duration = max(0, time() - strtotime((string) $record['start_at']));
        $now = date('Y-m-d H:i:s');
        Db::name('work_task_records')->where('id', $recordId)->update(['status' => 'pending_review', 'submitted_at' => $now, 'duration_seconds' => $duration, 'answers_json' => json_encode($normalized, JSON_UNESCAPED_UNICODE), 'updated_at' => $now]);
        // The pending state is private to this transaction: answers, grading,
        // wage, receipt and audit commit together or all roll back.
        return $this->autoReviewRecord((array) Db::name('work_task_records')->where('id', $recordId)->find());
        });
    }

    /** Caller holds the record lock in the submission transaction. */
    private function autoReviewRecord(array $record): array
    {
        $snapshot = $this->jsonArray($record['question_snapshot_json']);
        if (count($snapshot) !== (int) $record['total_questions']) throw new RuntimeException('作业题目快照不完整，无法自动结算，请联系管理员。');
        $answers = $this->normalizeAnswers($snapshot, $this->jsonMap($record['answers_json']), true);
        $review = [];
        foreach ($snapshot as $question) {
            $key = (string) ($question['question_uuid'] ?? '');
            $standard = array_key_exists('correct_answer', $question) ? $this->answerValue($question['correct_answer']) : null;
            if ($key === '' || array_key_exists($key, $review) || $standard === null) {
                throw new RuntimeException('作业标准答案快照不完整，无法自动结算，请联系管理员。');
            }
            $review[$key] = $answers[$key] === $standard;
        }
        $correct = count(array_filter($review, static fn (bool $value): bool => $value));
        $wrong = count($review) - $correct;
        $unit = WorkTaskMoney::assertMaximum(count($snapshot), $record['unit_price']);
        $wage = WorkTaskMoney::amount($correct * $unit);
        $now = date('Y-m-d H:i:s'); $id = (int) $record['id']; $requestId = 'work-auto-review-' . $id;
        Db::name('work_task_records')->where('id', $id)->update([
            'status' => 'reviewed', 'reviewed_at' => $now, 'reviewer_id' => null, 'reviewer_admin_id' => null,
            'correct_count' => $correct, 'wrong_count' => $wrong, 'wage' => $wage,
            'review_results_json' => json_encode((object) $review, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR),
            'review_note' => '系统按开工时标准答案自动批改', 'updated_at' => $now,
        ]);
        $result = $this->recordPayload($this->joinedRecord($id), true);
        $receipt = $result;
        unset($receipt['record']['nickname'], $receipt['record']['username'], $receipt['record']['avatar_url']);
        Db::name('work_record_reviews')->insert([
            'request_id' => $requestId, 'record_id' => $id, 'reviewer_admin_id' => 0,
            'payload_hash' => hash('sha256', json_encode(['record_id' => $id, 'answers' => $answers, 'results' => $review, 'unit_price' => $record['unit_price']], JSON_THROW_ON_ERROR)),
            'result_json' => json_encode($receipt, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), 'created_at' => $now,
        ]);
        (new AuditService())->log(0, 'work_record.auto_review', 'work', $id, $requestId, '', [
            'employee_type' => $record['employee_type'], 'unit_price' => $record['unit_price'],
            'correct_count' => $correct, 'wrong_count' => $wrong, 'wage' => $wage,
        ]);
        return $result;
    }

    public function adminRecords(array $filters): array
    {
        $page = max(1, (int) ($filters['page'] ?? 1)); $size = min(100, max(1, (int) ($filters['size'] ?? 20)));
        $query = Db::name('work_task_records')->alias('r')->leftJoin('work_tasks t', 't.id = r.task_id')->leftJoin('users u', 'u.id = r.user_id')->field('r.*,t.task_key,t.name task_name,u.nickname,u.username,u.avatar_url')->order('r.id', 'desc');
        $userId = (int) ($filters['user_id'] ?? 0); $taskId = (int) ($filters['task_id'] ?? 0); $status = (string) ($filters['status'] ?? '');
        if ($userId > 0) $query->where('r.user_id', $userId); if ($taskId > 0) $query->where('r.task_id', $taskId); if (in_array($status, ['in_progress', 'pending_review', 'reviewed'], true)) $query->where('r.status', $status);
        foreach (['date_from' => '>=', 'date_to' => '<='] as $field => $operator) {
            $date = (string) ($filters[$field] ?? '');
            if ($date !== '') { if (!preg_match('/^\d{4}-\d{2}-\d{2}$/D', $date)) throw new RuntimeException('日期格式不正确。'); $query->where('r.task_date', $operator, $date); }
        }
        $rows = $query->paginate(['list_rows' => $size, 'page' => $page]);
        return ['items' => array_map(fn (array $row): array => $this->formatRecord($row), $rows->items()), 'total' => $rows->total(), 'page' => $rows->currentPage(), 'size' => $size];
    }

    public function adminRecordDetail(int $recordId): array
    {
        $record = Db::name('work_task_records')->alias('r')->leftJoin('work_tasks t', 't.id = r.task_id')->leftJoin('users u', 'u.id = r.user_id')->field('r.*,t.task_key,t.name task_name,u.nickname,u.username,u.avatar_url')->where('r.id', $recordId)->find();
        if (!$record) throw new RuntimeException('作业记录不存在。');
        return $this->recordPayload((array) $record, false);
    }

    public function reviewRecord(int $recordId, int $reviewerId, array $results, string $note = '', string $requestId = '', string $ip = ''): array
    {
        $requestId = $requestId !== '' ? $requestId : 'work-review-' . bin2hex(random_bytes(16));
        if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/D', $requestId)) throw new RuntimeException('批改请求编号格式不正确。');
        return Db::transaction(function () use ($recordId, $reviewerId, $results, $note, $requestId, $ip): array {
        $record = Db::name('work_task_records')->where('id', $recordId)->lock(true)->find(); if (!$record) throw new RuntimeException('作业记录不存在。');
        if ($record['status'] === 'in_progress') throw new RuntimeException('作业尚未提交，不能批改。');
        $snapshot = $this->jsonArray($record['question_snapshot_json']); $answers = $this->jsonMap($record['answers_json']); $review = [];
        $receiptQuery = Db::name('work_record_reviews')->where('request_id', $requestId);
        // A caller may already own an older RR snapshot. A final record needs a current receipt read.
        if ($record['status'] !== 'pending_review') $receiptQuery->lock(true);
        $receipt = $receiptQuery->find();
        if ($record['status'] !== 'pending_review' && (!$receipt || (int) $receipt['record_id'] !== $recordId || (int) $receipt['reviewer_admin_id'] !== $reviewerId)) $this->reviewConflict();
        try { $results = $this->normalizeAnswers($snapshot, $results, false); }
        catch (RuntimeException $error) { if ($record['status'] !== 'pending_review') $this->reviewConflict(); throw $error; }
        ksort($results);
        $note = mb_substr(trim($note), 0, 500);
        $hash = hash('sha256', json_encode(['record_id' => $recordId, 'reviewer_id' => $reviewerId, 'results' => $results, 'note' => $note], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));
        if ($reviewerId > 0 && !Db::name('admin_accounts')->where('id', $reviewerId)->where('status', 'active')->lock(true)->find()) throw new RuntimeException('批改管理员不存在或已停用。');
        if ($receipt) {
            if ((int) $receipt['record_id'] !== $recordId || (int) $receipt['reviewer_admin_id'] !== $reviewerId || !hash_equals($receipt['payload_hash'], $hash)) $this->reviewConflict();
            return $this->reviewIdentity(json_decode($receipt['result_json'], true, 512, JSON_THROW_ON_ERROR), (int) $record['user_id']);
        }
        if ($record['status'] !== 'pending_review') $this->reviewConflict();
        foreach ($snapshot as $question) {
            $key = (string) ($question['question_uuid'] ?? ''); $value = array_key_exists($key, $results) ? $this->answerValue($results[$key]) : null;
            if ($value === null && array_key_exists($key, $answers) && array_key_exists('correct_answer', $question)) $value = (bool) $answers[$key] === (bool) $question['correct_answer'];
            if ($value === null) throw new RuntimeException('请完成全部题目的批改。');
            $review[$key] = $value;
        }
        $correct = count(array_filter($review, static fn ($value): bool => (bool) $value)); $wrong = count($review) - $correct;
        $unitPriceMillis = WorkTaskMoney::assertMaximum(count($snapshot), $record['unit_price']);
        $wage = WorkTaskMoney::amount($correct * $unitPriceMillis); $now = date('Y-m-d H:i:s');
        Db::name('work_task_records')->where('id', $recordId)->update(['status' => 'reviewed', 'reviewed_at' => $now, 'reviewer_id' => null, 'reviewer_admin_id' => $reviewerId > 0 ? $reviewerId : null, 'correct_count' => $correct, 'wrong_count' => $wrong, 'wage' => $wage, 'review_results_json' => json_encode($review, JSON_UNESCAPED_UNICODE), 'review_note' => mb_substr(trim($note), 0, 500), 'updated_at' => $now]);
        $result = $this->recordPayload($this->joinedRecord($recordId), false);
        // Mutable personal data is never an immutable part of a grading receipt.
        unset($result['record']['nickname'], $result['record']['username'], $result['record']['avatar_url']);
        $encodedResult = json_encode($result, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
        $result = json_decode($encodedResult, true, 512, JSON_THROW_ON_ERROR);
        try {
            Db::name('work_record_reviews')->insert(['request_id' => $requestId, 'record_id' => $recordId, 'reviewer_admin_id' => $reviewerId, 'payload_hash' => $hash, 'result_json' => $encodedResult, 'created_at' => $now]);
        } catch (\think\db\exception\DuplicateException) { $this->reviewConflict(); }
        (new AuditService())->log($reviewerId, 'work_record.review', 'work', $recordId, $requestId, $ip, ['correct_count' => $correct, 'wrong_count' => $wrong]);
        // MySQL JSON canonicalizes object-key order. Return that same stored shape on the first call too.
        return $this->reviewIdentity(json_decode((string) Db::name('work_record_reviews')->where('request_id', $requestId)->value('result_json'), true, 512, JSON_THROW_ON_ERROR), (int) $record['user_id']);
        });
    }

    private function reviewIdentity(array $result, int $userId): array
    {
        // A current read also respects retention committed after an older outer RR snapshot.
        $user = Db::name('users')->where('id', $userId)->field('nickname,username,avatar_url,status')->lock(true)->find();
        $anonymous = !$user || ($user['status'] ?? '') === 'deleted';
        $result['record']['nickname'] = $anonymous ? '已注销用户' : (string) ($user['nickname'] ?? '');
        $result['record']['username'] = $anonymous ? '' : (string) ($user['username'] ?? '');
        $result['record']['avatar_url'] = $anonymous ? '' : (string) ($user['avatar_url'] ?? '');
        return $result;
    }

    private function reviewConflict(): never
    {
        throw new \think\exception\HttpResponseException(json(['ok' => false, 'error' => ['code' => 'REVIEW_CONFLICT', 'message' => '此作业已经批改或请求编号已用于其他内容，请刷新记录。']], 409)->header(['Cache-Control' => 'no-store']));
    }

    private function mobileTask(array $task, ?array $record, string $employeeType = 'intern'): array
    {
        $status = 'not_started'; $label = '未开始';
        if ($record) { $status = (string) $record['status']; $label = $status === 'reviewed' ? '已完成' : ($status === 'pending_review' ? '待批改' : '进行中'); }
        elseif ($this->beijingNow()->format('H:i:s') >= (string) $task['open_time']) { $status = 'available'; $label = '可开始'; }
        $unit = $record['unit_price'] ?? ($employeeType === 'formal' ? $task['formal_unit_price'] : $task['intern_unit_price']);
        $questionCount = (int) ($record['total_questions'] ?? $task['today_question_count'] ?? $task['question_count']);
        return ['id' => (int) $task['id'], 'task_key' => $task['task_key'], 'name' => $task['name'], 'open_time' => substr((string) $task['open_time'], 0, 5), 'estimated_minutes' => (int) $task['estimated_minutes'], 'description' => (string) ($task['description'] ?? ''), 'intern_unit_price' => (float) $task['intern_unit_price'], 'formal_unit_price' => (float) $task['formal_unit_price'], 'question_count' => $questionCount, 'configured_question_count' => (int) $task['question_count'], 'correct_question_count' => intdiv($questionCount, 2), 'wrong_question_count' => intdiv($questionCount, 2), 'estimated_wage' => (float) WorkTaskMoney::amount(WorkTaskMoney::assertMaximum($questionCount, $unit) * $questionCount), 'status' => $status, 'status_label' => $label, 'record' => $record ? $this->formatRecord($record) : null];
    }

    /**
     * 按北京时间日期获取每日题目批次。首次访问当天任务时生成，跨过 00:00 后自然生成新批次。
     * 唯一索引负责并发收敛，避免多个用户首次进入时生成不同的题目组合。
     */
    private function dailyQuestionBatch(int $taskId, string $taskDate, int $questionCount): array
    {
        if ($questionCount < 2 || $questionCount % 2 !== 0) throw new RuntimeException('题目数量必须是偶数，系统会按正确答案和错误答案各一半随机抽取。');
        $table = Db::name('work_task_daily_questions');
        $where = ['task_id' => $taskId, 'task_date' => $taskDate];
        $row = $table->where($where)->lock(true)->find();
        if (!$row) {
            $perAnswer = intdiv($questionCount, 2);
            $correctAvailable = (int) Db::name('work_questions')->where('correct_answer', 1)->count();
            $wrongAvailable = (int) Db::name('work_questions')->where('correct_answer', 0)->count();
            if ($correctAvailable < $perAnswer || $wrongAvailable < $perAnswer) {
                throw new RuntimeException(sprintf('题库数量不足：需要%d道正确题和%d道错误题，当前分别只有%d道和%d道。', $perAnswer, $perAnswer, $correctAvailable, $wrongAvailable));
            }
            $correctIds = array_map('intval', Db::name('work_questions')->where('correct_answer', 1)->orderRaw('RAND()')->limit($perAnswer)->column('id'));
            $wrongIds = array_map('intval', Db::name('work_questions')->where('correct_answer', 0)->orderRaw('RAND()')->limit($perAnswer)->column('id'));
            if (count($correctIds) !== $perAnswer || count($wrongIds) !== $perAnswer) {
                throw new RuntimeException('题库在生成每日题目时发生变化，请稍后重试。');
            }
            $questionIds = array_merge($correctIds, $wrongIds);
            shuffle($questionIds);
            $selectedRows = Db::name('work_questions')->whereIn('id', $questionIds)->select()->toArray();
            $selectedById = [];
            foreach ($selectedRows as $selectedRow) $selectedById[(int) $selectedRow['id']] = $selectedRow;
            $snapshot = [];
            foreach ($questionIds as $questionId) {
                if (!isset($selectedById[$questionId])) throw new RuntimeException('题库在生成每日题目时发生变化，请稍后重试。');
                $snapshot[] = $this->formatQuestion($selectedById[$questionId], true);
            }
            $now = date('Y-m-d H:i:s');
            $data = ['task_id' => $taskId, 'task_date' => $taskDate, 'question_ids_json' => json_encode($questionIds, JSON_UNESCAPED_UNICODE), 'questions_snapshot_json' => json_encode($snapshot, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), 'total_count' => $questionCount, 'correct_count' => $perAnswer, 'wrong_count' => $perAnswer, 'created_at' => $now, 'updated_at' => $now];
            try {
                $table->insert($data);
            } catch (\Throwable $error) {
                // 另一个并发请求已经写入当天批次时，读取它即可；其他数据库错误继续抛出。
                $row = $table->where($where)->find();
                if (!$row) throw $error;
            }
            $row ??= $table->where($where)->find();
        }
        $ids = $this->jsonList($row['question_ids_json'] ?? '[]');
        // A batch already created today is immutable; a changed task count is used next day.
        $actualCount = (int) ($row['total_count'] ?? 0);
        if ($actualCount < 2 || $actualCount > self::MAX_QUESTIONS_PER_TASK || $actualCount % 2 !== 0 || count($ids) !== $actualCount || (int) ($row['correct_count'] ?? 0) !== intdiv($actualCount, 2) || (int) ($row['wrong_count'] ?? 0) !== intdiv($actualCount, 2)) {
            throw new RuntimeException('当天题目批次配置异常，请联系管理员处理。');
        }
        return ['ids' => $ids, 'questions' => $this->jsonArray($row['questions_snapshot_json'] ?? '[]'), 'total_count' => (int) $row['total_count'], 'correct_count' => (int) $row['correct_count'], 'wrong_count' => (int) $row['wrong_count']];
    }

    private function validateQuestionPool(int $questionCount): void
    {
        $perAnswer = intdiv($questionCount, 2);
        $correct = (int) Db::name('work_questions')->where('correct_answer', 1)->count();
        $wrong = (int) Db::name('work_questions')->where('correct_answer', 0)->count();
        if ($correct < $perAnswer || $wrong < $perAnswer) throw new RuntimeException(sprintf('题库数量不足：启用任务需要%d道正确题和%d道错误题，当前分别只有%d道和%d道。', $perAnswer, $perAnswer, $correct, $wrong));
    }

    private function questionsForDailyBatch(array $batch): array
    {
        $snapshot = $this->jsonArray($batch['questions'] ?? []);
        if (count($snapshot) === (int) ($batch['total_count'] ?? 0)) {
            $correct = count(array_filter($snapshot, static fn (array $question): bool => (bool) ($question['correct_answer'] ?? false)));
            if ($correct !== (int) $batch['correct_count'] || count($snapshot) - $correct !== (int) $batch['wrong_count']) throw new RuntimeException('当天题目批次答案比例异常，请联系管理员处理。');
            return $snapshot;
        }
        $ids = array_values(array_map('intval', $batch['ids'] ?? []));
        if ($ids === []) throw new RuntimeException('当天题目批次为空，请联系管理员处理。');
        $rows = Db::name('work_questions')->whereIn('id', $ids)->select()->toArray();
        $byId = [];
        foreach ($rows as $row) $byId[(int) $row['id']] = $row;
        $questions = [];
        foreach ($ids as $id) {
            if (!isset($byId[$id])) throw new RuntimeException('当天题目已从题库移除，请联系管理员重新生成题库。');
            $questions[] = $byId[$id];
        }
        $correct = count(array_filter($questions, static fn (array $question): bool => (bool) $question['correct_answer']));
        if ($correct !== (int) $batch['correct_count'] || count($questions) - $correct !== (int) $batch['wrong_count']) throw new RuntimeException('当天题目批次答案比例异常，请联系管理员处理。');
        return $questions;
    }

    private function recordPayload(array $record, bool $hideAnswers): array
    {
        $snapshot = $this->jsonArray($record['question_snapshot_json'] ?? '[]'); $answers = $this->jsonMap($record['answers_json'] ?? '{}'); $reviews = $this->jsonMap($record['review_results_json'] ?? '{}');
        $reviewed = ($record['status'] ?? '') === 'reviewed';
        $questions = array_map(function (array $question) use ($answers, $reviews, $hideAnswers, $reviewed): array { $question['answer'] = $answers[$question['question_uuid']] ?? null; $question['reviewed_correct'] = (!$hideAnswers || $reviewed) ? ($reviews[$question['question_uuid']] ?? null) : null; if ($hideAnswers && !$reviewed) unset($question['correct_answer']); return $question; }, $snapshot);
        $result = ['record' => $this->formatRecord($record), 'questions' => $questions, 'answers' => (object) $answers, 'review_results' => (object) ((!$hideAnswers || $reviewed) ? $reviews : [])];
        return $result;
    }

    private function formatTask(array $row): array
    {
        $status = (string) ($row['status'] ?? 'disabled');
        $openTime = substr((string) ($row['open_time'] ?? '00:00:00'), 0, 8);
        $openStatus = $status === 'disabled' ? 'disabled' : ($this->beijingNow()->format('H:i:s') >= $openTime ? 'open' : 'not_open');
        $openStatusLabel = ['open' => '已开放', 'not_open' => '未开放', 'disabled' => '已禁用'][$openStatus];
        $configured = (int) ($row['question_count'] ?? 0); $today = (int) ($row['today_question_count'] ?? $configured);
        return ['id' => (int) ($row['id'] ?? 0), 'task_key' => (string) ($row['task_key'] ?? ''), 'name' => (string) ($row['name'] ?? ''), 'open_time' => $openTime, 'estimated_minutes' => (int) ($row['estimated_minutes'] ?? 0), 'description' => (string) ($row['description'] ?? ''), 'intern_unit_price' => (float) ($row['intern_unit_price'] ?? 0), 'formal_unit_price' => (float) ($row['formal_unit_price'] ?? 0), 'question_count' => $configured, 'today_question_count' => $today, 'question_count_effective_from' => $today !== $configured ? $this->beijingNow()->modify('+1 day')->format('Y-m-d') : $this->beijingDate(), 'sort_order' => (int) ($row['sort_order'] ?? 0), 'status' => $status, 'status_label' => $status === 'enabled' ? '启用' : '禁用', 'open_status' => $openStatus, 'open_status_label' => $openStatusLabel, 'created_at' => (string) ($row['created_at'] ?? ''), 'updated_at' => (string) ($row['updated_at'] ?? '')];
    }

    private function withTodayCounts(array $rows, bool $current = false): array
    {
        if ($rows === []) return [];
        $query = Db::name('work_task_daily_questions')->where('task_date', $this->beijingDate())->whereIn('task_id', array_column($rows, 'id'));
        if ($current) $query->lock(true);
        $counts = $query->column('total_count', 'task_id');
        foreach ($rows as &$row) $row['today_question_count'] = (int) ($counts[$row['id']] ?? $row['question_count']);
        unset($row);
        return $rows;
    }

    private function formatQuestion(array $row, bool $includeAnswer): array
    {
        $result = ['id' => (int) ($row['id'] ?? 0), 'question_uuid' => (string) ($row['question_uuid'] ?? ''), 'image_url' => (string) ($row['image_url'] ?? ''), 'created_at' => (string) ($row['created_at'] ?? ''), 'updated_at' => (string) ($row['updated_at'] ?? '')];
        if ($includeAnswer) $result['correct_answer'] = (bool) ($row['correct_answer'] ?? false);
        return $result;
    }

    private function formatRecord(array $row): array
    {
        return ['id' => (int) ($row['id'] ?? 0), 'user_id' => (int) ($row['user_id'] ?? 0), 'nickname' => (string) ($row['nickname'] ?? ''), 'username' => (string) ($row['username'] ?? ''), 'avatar_url' => (string) ($row['avatar_url'] ?? ''), 'task_id' => (int) ($row['task_id'] ?? 0), 'task_key' => (string) ($row['task_key'] ?? ''), 'task_name' => (string) ($row['task_name'] ?? ''), 'task_date' => (string) ($row['task_date'] ?? ''), 'employee_type' => (string) ($row['employee_type'] ?? 'intern'), 'status' => (string) ($row['status'] ?? 'in_progress'), 'status_label' => ['in_progress' => '进行中', 'pending_review' => '待批改', 'reviewed' => '已完成'][(string) ($row['status'] ?? '')] ?? '未知', 'start_at' => (string) ($row['start_at'] ?? ''), 'submitted_at' => (string) ($row['submitted_at'] ?? ''), 'reviewed_at' => (string) ($row['reviewed_at'] ?? ''), 'duration_seconds' => (int) ($row['duration_seconds'] ?? 0), 'total_questions' => (int) ($row['total_questions'] ?? 0), 'correct_count' => (int) ($row['correct_count'] ?? 0), 'wrong_count' => (int) ($row['wrong_count'] ?? 0), 'unit_price' => (float) ($row['unit_price'] ?? 0), 'wage' => (float) ($row['wage'] ?? 0), 'review_note' => (string) ($row['review_note'] ?? '')];
    }

    private function decimal(mixed $value, string $label): string
    {
        return WorkTaskMoney::amount(WorkTaskMoney::unitMillis($value, $label));
    }

    private function answerValue(mixed $value): ?bool
    {
        if (is_bool($value)) return $value; if (is_int($value) || is_float($value)) return $value === 0 || $value === 0.0 ? false : ($value === 1 || $value === 1.0 ? true : null);
        if (!is_string($value)) return null;
        $value = mb_strtolower(trim((string) $value)); if (in_array($value, ['1', 'true', 'yes', 'y', '对', '正确', '是'], true)) return true; if (in_array($value, ['0', 'false', 'no', 'n', '错', '错误', '否'], true)) return false; return null;
    }

    private function normalizeAnswers(array $questions, array $answers, bool $complete): array
    {
        $keys = array_fill_keys(array_column($questions, 'question_uuid'), true); $normalized = [];
        foreach ($answers as $key => $value) {
            if (!isset($keys[(string) $key])) throw new RuntimeException('答案包含不属于此作业的题目。');
            $answer = $this->answerValue($value);
            if ($answer === null) throw new RuntimeException('答案只能填写对或错。');
            $normalized[(string) $key] = $answer;
        }
        if ($complete && count($normalized) !== count($questions)) throw new RuntimeException('请完成全部题目后再提交。');
        return $normalized;
    }

    private function joinedRecord(int $id): array
    {
        $record = Db::name('work_task_records')->alias('r')->leftJoin('work_tasks t', 't.id = r.task_id')->leftJoin('users u', 'u.id = r.user_id')->field('r.*,t.task_key,t.name task_name,u.nickname,u.username,u.avatar_url')->where('r.id', $id)->find();
        if (!$record) throw new RuntimeException('作业记录不存在。');
        return $record;
    }

    private function jsonArray(mixed $value): array { $decoded = is_array($value) ? $value : json_decode((string) $value, true); return is_array($decoded) ? array_values(array_filter($decoded, 'is_array')) : []; }
    private function jsonMap(mixed $value): array { $decoded = is_array($value) ? $value : json_decode((string) $value, true); return is_array($decoded) ? $decoded : []; }
    private function jsonList(mixed $value): array { $decoded = is_array($value) ? $value : json_decode((string) $value, true); return is_array($decoded) ? array_values(array_unique(array_map('intval', $decoded))) : []; }
    private function uuid(): string { $data = random_bytes(16); $data[6] = chr((ord($data[6]) & 0x0f) | 0x40); $data[8] = chr((ord($data[8]) & 0x3f) | 0x80); return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4)); }
}
