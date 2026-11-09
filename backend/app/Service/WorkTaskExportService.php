<?php
namespace app\Service;

use RuntimeException;
use think\facade\Db;
use ZipArchive;

/** Writes one small XML row at a time; database pages never contain question snapshots. */
final class WorkTaskExportService
{
    public const MAX_ROWS = 100000;
    private $connection;

    public function __construct($connection = null, private bool $ownSnapshot = true)
    {
        // A dedicated connection leaves the request's normal connection/transaction untouched.
        $this->connection = $connection ?? Db::connect(Db::connect()->getConfig(), true);
    }

    public function build(string $kind, array $filters): array
    {
        if (!in_array($kind, ['questions', 'records'], true)) throw new RuntimeException('未知导出类型。');
        $directory = app()->getRuntimePath() . 'work-exports';
        if (!is_dir($directory) && !mkdir($directory, 0700, true) && !is_dir($directory)) throw new RuntimeException('无法创建导出目录。');
        $xml = tempnam($directory, 'sheet-'); $xlsx = tempnam($directory, 'export-');
        if ($xml === false || $xlsx === false) { if ($xml) @unlink($xml); if ($xlsx) @unlink($xlsx); throw new RuntimeException('无法创建导出文件。'); }
        @chmod($xml, 0600); @chmod($xlsx, 0600);
        register_shutdown_function(static function () use ($xml, $xlsx): void { if (is_file($xml)) @unlink($xml); if (is_file($xlsx)) @unlink($xlsx); });
        $stream = null; $started = false; $complete = false;
        try {
            if ($this->ownSnapshot) {
                $this->connection->execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
                $this->connection->startTrans(); $started = true;
            }
            $total = (int) $this->query($kind, $filters)->count();
            if ($total > self::MAX_ROWS) throw new RuntimeException('导出最多支持100000条，请缩小日期或其他筛选范围后重试。');
            $stream = fopen($xml, 'wb');
            if ($stream === false) throw new RuntimeException('无法写入导出文件。');
            $this->write($stream, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>');
            $headers = $kind === 'questions' ? ['题目UUID', '图片地址', '正确答案'] : ['记录ID', '用户ID', '昵称', '任务名称', '作业日期', '员工类型', '状态', '开始时间', '完成时间', '完成耗时（秒）', '总题数', '批改正确', '批改错误', '工资收入'];
            $this->row($stream, 1, $headers); $last = 0; $written = 0;
            while (true) {
                $key = $kind === 'questions' ? 'id' : 'r.id';
                $rows = $this->query($kind, $filters)->where($key, '>', $last)->order($key)->limit(250)->select()->toArray();
                if ($rows === []) break;
                foreach ($rows as $row) {
                    $last = (int) $row['id']; $written++;
                    if ($written > self::MAX_ROWS) throw new RuntimeException('导出超过100000条，请缩小筛选范围。');
                    $values = $kind === 'questions' ? [$row['question_uuid'], $row['image_url'], $row['correct_answer'] ? '对' : '错']
                        : [$row['id'], $row['user_id'], $row['nickname'], $row['task_name'], $row['task_date'], $row['employee_type'] === 'formal' ? '正式员工' : '实习员工', ['in_progress' => '进行中', 'pending_review' => '待批改', 'reviewed' => '已完成'][$row['status']] ?? '未知', $row['start_at'], $row['submitted_at'], $row['duration_seconds'], $row['total_questions'], $row['correct_count'], $row['wrong_count'], $row['wage']];
                    $this->row($stream, $written + 1, $values);
                }
                unset($rows);
            }
            if ($written !== $total) throw new RuntimeException('导出快照数量不一致，请重试。');
            $this->write($stream, '</sheetData></worksheet>'); fclose($stream); $stream = null;
            if ($started) { $this->connection->commit(); $started = false; }
            $zip = new ZipArchive();
            if ($zip->open($xlsx, ZipArchive::OVERWRITE) !== true) throw new RuntimeException('无法生成Excel文件。');
            try {
                $files = [
                    '[Content_Types].xml' => '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
                    '_rels/.rels' => '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
                    'xl/workbook.xml' => '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="导出数据" sheetId="1" r:id="rId1"/></sheets></workbook>',
                    'xl/_rels/workbook.xml.rels' => '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
                ];
                foreach ($files as $name => $contents) if (!$zip->addFromString($name, $contents)) throw new RuntimeException('无法写入Excel文件。');
                if (!$zip->addFile($xml, 'xl/worksheets/sheet1.xml')) throw new RuntimeException('无法写入Excel数据。');
            } finally { if (!$zip->close()) throw new RuntimeException('无法完成Excel文件。'); }
            $complete = true;
            return ['path' => $xlsx, 'count' => $written];
        } finally {
            if (is_resource($stream)) fclose($stream);
            try { if ($started) $this->connection->rollback(); }
            finally {
                try { if ($this->ownSnapshot) $this->connection->close(); }
                finally { @unlink($xml); if (!$complete) @unlink($xlsx); }
            }
        }
    }

    private function query(string $kind, array $filters)
    {
        if ($kind === 'questions') {
            $query = $this->connection->name('work_questions')->field('id,question_uuid,image_url,correct_answer');
            $uuid = trim((string) ($filters['uuid'] ?? '')); $answer = (string) ($filters['answer'] ?? '');
            if ($uuid !== '') $query->whereLike('question_uuid', '%' . addcslashes($uuid, '%_') . '%');
            if (in_array($answer, ['0', '1'], true)) $query->where('correct_answer', (int) $answer);
            return $query;
        }
        $query = $this->connection->name('work_task_records')->alias('r')->leftJoin('work_tasks t', 't.id=r.task_id')->leftJoin('users u', 'u.id=r.user_id')
            ->field('r.id,r.user_id,r.task_date,r.employee_type,r.status,r.start_at,r.submitted_at,r.duration_seconds,r.total_questions,r.correct_count,r.wrong_count,r.wage,t.name task_name,u.nickname');
        foreach (['user_id', 'task_id'] as $field) if ((int) ($filters[$field] ?? 0) > 0) $query->where('r.' . $field, (int) $filters[$field]);
        $status = (string) ($filters['status'] ?? ''); if (in_array($status, ['in_progress', 'pending_review', 'reviewed'], true)) $query->where('r.status', $status);
        foreach (['date_from' => '>=', 'date_to' => '<='] as $field => $operator) {
            $date = (string) ($filters[$field] ?? '');
            if ($date !== '') { if (!preg_match('/^\d{4}-\d{2}-\d{2}$/D', $date) || !checkdate((int) substr($date, 5, 2), (int) substr($date, 8, 2), (int) substr($date, 0, 4))) throw new RuntimeException('日期格式不正确。'); $query->where('r.task_date', $operator, $date); }
        }
        return $query;
    }

    private function row($stream, int $number, array $values): void
    {
        $text = '<row r="' . $number . '">';
        foreach ($values as $index => $value) {
            $column = ''; $n = $index + 1;
            while ($n > 0) { $n--; $column = chr(65 + $n % 26) . $column; $n = intdiv($n, 26); }
            $value = preg_replace('/[^\x{0009}\x{000A}\x{000D}\x{0020}-\x{D7FF}\x{E000}-\x{FFFD}\x{10000}-\x{10FFFF}]/u', '', (string) $value) ?? '';
            $text .= '<c r="' . $column . $number . '" t="inlineStr"><is><t xml:space="preserve">' . htmlspecialchars($value, ENT_XML1 | ENT_QUOTES, 'UTF-8') . '</t></is></c>';
        }
        $this->write($stream, $text . '</row>');
    }

    private function write($stream, string $text): void
    {
        $remaining = strlen($text); $offset = 0;
        while ($remaining > 0) { $written = fwrite($stream, substr($text, $offset)); if ($written === false || $written === 0) throw new RuntimeException('导出磁盘空间不足。'); $remaining -= $written; $offset += $written; }
    }
}
