<?php

namespace app\Service;

use PhpOffice\PhpSpreadsheet\IOFactory;
use PhpOffice\PhpSpreadsheet\Worksheet\Drawing;
use PhpOffice\PhpSpreadsheet\Worksheet\MemoryDrawing;
use RuntimeException;

final class WorkQuestionImporter
{
    public const MAX_ROWS = 10000;

    public function read(string $path, string $extension, ?array $account = null): array
    {
        if ($extension === 'xlsx') {
            $zip = new \ZipArchive();
            if ($zip->open($path) !== true) throw new RuntimeException('无法读取Excel文件。');
            $size = 0;
            try {
                for ($index = 0; $index < $zip->numFiles; $index++) {
                    $size += (int) ($zip->statIndex($index)['size'] ?? 0);
                    if ($size > 80 * 1024 * 1024 || $zip->numFiles > 20000) throw new RuntimeException('Excel解压后内容过大，请拆分后导入。');
                }
            } finally { $zip->close(); }
        }
        $reader = IOFactory::createReader(match ($extension) { 'xlsx' => 'Xlsx', 'xls' => 'Xls', default => 'Csv' });
        if ($extension === 'csv') {
            $sample = file_get_contents($path, false, null, 0, 4096) ?: '';
            $reader->setInputEncoding(mb_check_encoding($sample, 'UTF-8') ? 'UTF-8' : 'GB18030');
        }
        $info = $reader->listWorksheetInfo($path);
        if (($info[0]['totalRows'] ?? 0) > self::MAX_ROWS + 1) throw new RuntimeException('每次最多导入10000道题，请拆分文件。');
        if (($info[0]['totalColumns'] ?? 0) > 32) throw new RuntimeException('题库只需要题目编号、图片和答案列，请移除多余的工作表列。');
        $book = $reader->load($path);
        try {
            $sheet = $book->getSheet(0);
            $lastRow = min(self::MAX_ROWS + 1, $sheet->getHighestDataRow());
            $lastCol = $sheet->getHighestDataColumn();
            $raw = $sheet->rangeToArray('A1:' . $lastCol . $lastRow, null, false, false);
            $header = array_map(fn ($value) => $this->headerName((string) $value), $raw[0] ?? []);
            $hasHeader = in_array('correct_answer', $header, true);
            if (!$hasHeader) $header = count($raw[0] ?? []) === 2 ? ['image_url', 'correct_answer'] : ['question_uuid', 'image_url', 'correct_answer'];
            $pictures = [];
            foreach ($sheet->getDrawingCollection() as $drawing) {
                if (preg_match('/(\d+)$/', $drawing->getCoordinates(), $matches)) $pictures[(int) $matches[1]] = $drawing;
            }
            $rows = [];
            foreach ($raw as $index => $line) {
                if ($index === 0 && $hasHeader) continue;
                $row = ['_row' => $index + 1];
                foreach ($header as $column => $name) if ($name !== '') { $value = $line[$column] ?? ''; $row[$name] = is_bool($value) ? ($value ? '1' : '0') : trim((string) $value); }
                $picture = $pictures[$index + 1] ?? null;
                if ($picture && empty($row['image_url'])) $row['image_url'] = $this->storePicture($picture, $account);
                if (!empty($row['image_url']) || !empty($row['question_uuid']) || ($row['correct_answer'] ?? '') !== '') $rows[] = $row;
            }
            if ($rows === []) throw new RuntimeException('文件中未找到题目。需要图片地址（或内嵌图片）和正确答案列。');
            return $rows;
        } finally { $book->disconnectWorksheets(); }
    }

    private function headerName(string $value): string
    {
        $value = preg_replace('/[\s_\-\x{FEFF}]+/u', '', mb_strtolower(trim($value)));
        return match ($value) {
            '题目uuid', 'uuid', 'questionuuid', '题目编号' => 'question_uuid',
            '图片', '题目图片', '图片url', '图片地址', 'image', 'imageurl', 'url' => 'image_url',
            '正确答案', '答案', 'correctanswer', 'answer', '是否正确' => 'correct_answer',
            default => '',
        };
    }

    private function storePicture(Drawing|MemoryDrawing $picture, ?array $account = null): string
    {
        if ($picture instanceof MemoryDrawing) {
            if (!extension_loaded('gd')) throw new RuntimeException('内嵌图片导入需要服务器启用GD扩展。');
            ob_start();
            try { ($picture->getRenderingFunction())($picture->getImageResource()); $bytes = (string) ob_get_contents(); }
            finally { ob_end_clean(); }
        } else {
            // 仅接收工作簿内嵌文件，禁止在服务端请求Excel里的外部图片地址。
            $source = $picture->getPath();
            if (!str_starts_with($source, 'zip://') && !is_file($source)) throw new RuntimeException('不支持Excel中的外部图片，请填写图片地址列。');
            $bytes = file_get_contents($source, false, null, 0, 10 * 1024 * 1024 + 1);
        }
        $info = $bytes ? @getimagesizefromstring($bytes) : false;
        $extension = $info ? match ($info[2]) { IMAGETYPE_JPEG => 'jpg', IMAGETYPE_PNG => 'png', IMAGETYPE_GIF => 'gif', IMAGETYPE_WEBP => 'webp', default => '' } : '';
        if (!$bytes || strlen($bytes) > 10 * 1024 * 1024 || $extension === '') throw new RuntimeException('Excel内嵌图片无效或超过10MB。');
        $relative = 'work-questions/' . date('Y/m') . '/' . hash('sha256', $bytes) . '.' . $extension;
        $media = new MediaAccessService();
        if ($account !== null && !$media->canAdminRead($relative, $account)) {
            // Keep existing ownership intact. A genuine embedded image supplied by another
            // administrator gets a separate, stable path instead of overwriting its owner's grant.
            $relative = 'work-questions/' . date('Y/m') . '/' . hash('sha256', $bytes . "\0admin-upload:" . (int) $account['id']) . '.' . $extension;
        }
        $target = app()->getRootPath() . 'public/storage/' . $relative;
        if (!is_dir(dirname($target)) && !mkdir(dirname($target), 0755, true) && !is_dir(dirname($target))) throw new RuntimeException('无法创建图片目录。');
        if (!is_file($target) && file_put_contents($target, $bytes, LOCK_EX) === false) throw new RuntimeException('无法保存题目图片。');
        if ($account !== null && !\think\facade\Db::name('media_uploads')->where('path', $relative)->find()) {
            \think\facade\Db::name('media_uploads')->extra('IGNORE')->insert(['path' => $relative, 'user_id' => null, 'admin_id' => (int) $account['id'], 'kind' => 'question', 'created_at' => date('Y-m-d H:i:s')]);
        }
        $url = rtrim((string) env('FILE_BASE_URL', '/storage'), '/') . '/' . $relative;
        if ($account !== null) $media->assertAdminCanAttach($url, $account);
        return $url;
    }
}
