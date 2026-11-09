<?php

namespace app\controller;

use app\Service\AuditService;
use app\Service\WorkTaskService;
use app\Service\WorkQuestionImporter;
use RuntimeException;
use think\Request;
use think\exception\HttpResponseException;

final class AdminWorkTaskController
{
    public function tasks(Request $request)
    {
        $this->admin($request);
        return json(['ok' => true, 'data' => (new WorkTaskService())->adminTasks($request->get())]);
    }

    public function saveTask(Request $request)
    {
        $this->admin($request); $payload = $this->payload($request); $result = (new WorkTaskService())->saveTask($payload);
        $this->audit($request, 'work_task.save', (int) $result['id'], ['task_key' => $result['task_key']]);
        return json(['ok' => true, 'data' => $result], 201);
    }

    public function setStatus(Request $request)
    {
        $this->admin($request); $payload = $this->payload($request);
        $result = (new WorkTaskService())->setStatus((int) ($payload['id'] ?? 0), (string) ($payload['status'] ?? ''));
        $this->audit($request, 'work_task.status', (int) $result['id'], ['status' => $result['status']]);
        return json(['ok' => true, 'data' => $result]);
    }

    public function deleteTasks(Request $request)
    {
        $this->admin($request); $payload = $this->payload($request); $deleted = (new WorkTaskService())->deleteTasks(is_array($payload['ids'] ?? null) ? $payload['ids'] : []);
        $this->audit($request, 'work_task.delete', null, ['deleted' => $deleted]);
        return json(['ok' => true, 'data' => ['deleted' => $deleted]]);
    }

    public function taskCode(Request $request)
    {
        $this->admin($request); return json(['ok' => true, 'data' => (new WorkTaskService())->taskCode((int) $request->get('task_id', 0), (string) $request->get('date', ''), (string) $request->get('regenerate', '') === '1')]);
    }

    public function questions(Request $request)
    {
        $this->admin($request); return json(['ok' => true, 'data' => (new WorkTaskService())->adminQuestions($request->get())]);
    }

    public function saveQuestion(Request $request)
    {
        $this->admin($request); $payload = $this->payload($request);
        $result = (new WorkTaskService())->saveQuestion($payload, (new \app\Service\AdminAuthService())->authenticate($request));
        $this->audit($request, 'work_question.save', (int) $result['id'], ['question_uuid' => $result['question_uuid']]);
        return json(['ok' => true, 'data' => $result], 201);
    }

    public function deleteQuestions(Request $request)
    {
        $this->admin($request); $payload = $this->payload($request); $deleted = (new WorkTaskService())->deleteQuestions(is_array($payload['ids'] ?? null) ? $payload['ids'] : []);
        $this->audit($request, 'work_question.delete', null, ['deleted' => $deleted]);
        return json(['ok' => true, 'data' => ['deleted' => $deleted]]);
    }

    public function importQuestions(Request $request)
    {
        $this->admin($request); $file = $request->file('file');
        if (!$file || !$file->isValid()) throw new RuntimeException('请上传有效的Excel或CSV文件。');
        if ((int) $file->getSize() <= 0 || (int) $file->getSize() > 20 * 1024 * 1024) throw new RuntimeException('导入文件大小必须在20MB以内。');
        $extension = strtolower((string) $file->getOriginalExtension());
        if (!in_array($extension, ['xlsx', 'xls', 'csv'], true)) throw new RuntimeException('支持.xlsx、.xls和.csv格式。');
        $account = (new \app\Service\AdminAuthService())->authenticate($request);
        $rows = (new WorkQuestionImporter())->read($file->getRealPath(), $extension, $account);
        $result = (new WorkTaskService())->importQuestions($rows, $account);
        $this->audit($request, 'work_question.import', null, $result);
        return json(['ok' => true, 'data' => $result], 201);
    }

    public function uploadQuestionImage(Request $request)
    {
        $this->admin($request);
        $file = $request->file('file');
        if (!$file || !$file->isValid()) throw new RuntimeException('请上传有效的题目图片。');
        $size = (int) $file->getSize();
        $extension = strtolower((string) $file->getOriginalExtension());
        if ($size <= 0 || $size > 10 * 1024 * 1024) throw new RuntimeException('图片大小必须在10MB以内。');
        if (!in_array($extension, ['jpg', 'jpeg', 'png', 'gif', 'webp'], true)) throw new RuntimeException('题目图片支持JPG、PNG、GIF和WEBP格式。');
        if (@getimagesize($file->getRealPath()) === false) throw new RuntimeException('图片内容无效。');
        $relative = 'uploads/' . date('Y/m');
        $directory = app()->getRootPath() . 'public/storage/' . $relative;
        if (!is_dir($directory) && !mkdir($directory, 0755, true) && !is_dir($directory)) throw new RuntimeException('无法创建图片存储目录。');
        $name = bin2hex(random_bytes(16)) . '.' . preg_replace('/[^a-z0-9]/i', '', $extension);
        $file->move($directory, $name);
        (new \app\Service\MediaAccessService())->recordUpload($relative . '/' . $name, null, 'question', (new \app\Service\AdminAuthService())->id($request));
        $baseUrl = rtrim((string) env('FILE_BASE_URL', '/storage'), '/');
        return json(['ok' => true, 'data' => ['url' => $baseUrl . '/' . $relative . '/' . $name, 'path' => $relative . '/' . $name]], 201);
    }

    public function records(Request $request)
    {
        $this->admin($request); return json(['ok' => true, 'data' => (new WorkTaskService())->adminRecords($request->get())]);
    }

    public function recordDetail(Request $request)
    {
        $this->admin($request); return json(['ok' => true, 'data' => (new WorkTaskService())->adminRecordDetail((int) $request->get('id', 0))]);
    }

    public function review(Request $request)
    {
        $this->admin($request); $payload = $this->payload($request);
        if (!is_string($payload['request_id'] ?? null) || !preg_match('/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/D', $payload['request_id'])) throw new RuntimeException('请提供有效的批改请求编号。');
        $result = (new WorkTaskService())->reviewRecord((int) ($payload['record_id'] ?? 0), (new \app\Service\AdminAuthService())->id($request), is_array($payload['results'] ?? null) ? $payload['results'] : [], (string) ($payload['note'] ?? ''), $payload['request_id'], (string) $request->ip());
        return json(['ok' => true, 'data' => $result]);
    }

    public function exportQuestions(Request $request)
    {
        $this->admin($request);
        $file = (new \app\Service\WorkTaskExportService())->build('questions', $request->get());
        return new \app\Service\WorkTaskExportResponse($file['path'], 'question-bank.xlsx', $file['count']);
    }

    public function questionTemplate(Request $request)
    {
        $this->admin($request);
        return $this->spreadsheetResponse('question-template.xlsx', [['题目UUID', '图片地址', '正确答案'], ['', '', '对']]);
    }

    public function exportRecords(Request $request)
    {
        $this->admin($request);
        $file = (new \app\Service\WorkTaskExportService())->build('records', $request->get());
        return new \app\Service\WorkTaskExportResponse($file['path'], 'work-records.xlsx', $file['count']);
    }

    private function spreadsheetResponse(string $name, array $rows)
    {
        $book = new \PhpOffice\PhpSpreadsheet\Spreadsheet(); $sheet = $book->getActiveSheet();
        foreach ($rows as $rowIndex => $row) foreach ($row as $column => $value) $sheet->setCellValueExplicit([$column + 1, $rowIndex + 1], (string) $value, \PhpOffice\PhpSpreadsheet\Cell\DataType::TYPE_STRING);
        ob_start();
        try { (new \PhpOffice\PhpSpreadsheet\Writer\Xlsx($book))->save('php://output'); $bytes = (string) ob_get_contents(); }
        finally { ob_end_clean(); $book->disconnectWorksheets(); }
        return response($bytes, 200)->contentType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')->header(['Content-Disposition' => 'attachment; filename="' . $name . '"', 'Cache-Control' => 'no-store']);
    }
    private function admin(Request $request): void {
        (new \app\Service\AdminAuthService())->authorize($request);
    }
    private function payload(Request $request): array { $payload = $request->post(); if ($payload !== []) return $payload; $decoded = json_decode(trim($request->getContent()), true); return is_array($decoded) ? $decoded : []; }
    private function audit(Request $request, string $action, ?int $target, array $detail = []): void { $payload = $this->payload($request); (new AuditService())->log((new \app\Service\AdminAuthService())->id($request), $action, 'work', $target, (string) ($payload['request_id'] ?? ''), (string) $request->ip(), $detail); }
}
