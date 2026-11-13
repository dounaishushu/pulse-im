package core

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"encoding/csv"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/mishramadhav/xls"
	"github.com/xuri/excelize/v2"
	_ "golang.org/x/image/bmp"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"
	"image"
	"image/png"
)

const maxImportRows = 10000

func importHeader(s string) string {
	s = strings.ToLower(strings.Trim(strings.TrimSpace(s), "\ufeff"))
	s = strings.NewReplacer("_", "", "-", "", " ", "").Replace(s)
	switch s {
	case "uuid", "questionuuid", "题目uuid", "题目编号", "code":
		return "code"
	case "图片", "题目图片", "图片url", "图片地址", "image", "imageurl", "url":
		return "image"
	case "正确答案", "答案", "correctanswer", "answer", "是否正确", "correct":
		return "answer"
	}
	return ""
}

type importRow struct {
	Number   int
	Question WorkQuestion
	Error    string
}

func questionRows(raw [][]string) ([]importRow, error) {
	if len(raw) > maxImportRows+1 {
		return nil, &Fault{413, "question_import_limit"}
	}
	if len(raw) == 0 {
		return nil, ErrInvalid
	}
	header := []string{}
	hasHeader := false
	for _, cell := range raw[0] {
		h := importHeader(cell)
		header = append(header, h)
		if h == "answer" {
			hasHeader = true
		}
	}
	if !hasHeader {
		if len(raw[0]) == 2 {
			header = []string{"image", "answer"}
		} else {
			header = []string{"code", "image", "answer"}
		}
	}
	out := []importRow{}
	for i, row := range raw {
		if i == 0 && hasHeader {
			continue
		}
		if len(row) > 32 {
			return nil, &Fault{413, "question_column_limit"}
		}
		item := importRow{Number: i + 1}
		nonempty := false
		for j, cell := range row {
			if j >= len(header) {
				break
			}
			cell = strings.TrimSpace(cell)
			nonempty = nonempty || cell != ""
			switch header[j] {
			case "code":
				item.Question.Code = strings.ToLower(cell)
			case "image":
				if strings.HasPrefix(cell, "pulse-media:") {
					item.Question.MediaID = strings.TrimPrefix(cell, "pulse-media:")
				} else {
					item.Question.ImageURL = cell
				}
			case "answer":
				switch strings.ToLower(cell) {
				case "1", "true", "正确", "是":
					v := true
					item.Question.Correct = &v
				case "0", "false", "错误", "否":
					v := false
					item.Question.Correct = &v
				default:
					item.Error = "question_answer_invalid"
				}
			}
		}
		if nonempty {
			out = append(out, item)
		}
	}
	if len(out) > maxImportRows {
		return nil, &Fault{413, "question_import_limit"}
	}
	return out, nil
}
func readQuestionCSV(path string) ([]importRow, error) {
	f, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	sample := make([]byte, 4096)
	n, _ := f.Read(sample)
	_, _ = f.Seek(0, 0)
	var input io.Reader = f
	probe := sample[:n]
	for i := 0; i < 3 && len(probe) > 0 && !utf8.Valid(probe); i++ {
		probe = probe[:len(probe)-1]
	}
	if !utf8.Valid(probe) {
		input = transform.NewReader(f, simplifiedchinese.GB18030.NewDecoder())
	}
	r := csv.NewReader(bufio.NewReader(input))
	r.FieldsPerRecord = -1
	raw := [][]string{}
	for {
		row, e := r.Read()
		if errors.Is(e, io.EOF) {
			break
		}
		if e != nil {
			return nil, &Fault{422, "csv_invalid"}
		}
		if len(row) > 32 {
			return nil, &Fault{413, "question_column_limit"}
		}
		raw = append(raw, row)
		if len(raw) > maxImportRows+1 {
			return nil, &Fault{413, "question_import_limit"}
		}
	}
	return questionRows(raw)
}
func readQuestionXLS(path string) ([]importRow, error) {
	book, e := xls.Open(path, "utf-8")
	if e != nil {
		return nil, &Fault{422, "xls_invalid"}
	}
	sheet := book.GetSheet(0)
	if sheet == nil || sheet.Err() != nil {
		return nil, &Fault{422, "xls_invalid"}
	}
	if int(sheet.MaxRow) > maxImportRows {
		return nil, &Fault{413, "question_import_limit"}
	}
	raw := [][]string{}
	for i := 0; i <= int(sheet.MaxRow); i++ {
		row := sheet.Row(i)
		if row == nil {
			raw = append(raw, []string{})
			continue
		}
		if row.LastCol() > 32 {
			return nil, &Fault{413, "question_column_limit"}
		}
		values := []string{}
		for j := 0; j < row.LastCol(); j++ {
			values = append(values, row.Col(j))
		}
		raw = append(raw, values)
	}
	return questionRows(raw)
}
func readQuestionXLSX(path string) ([]importRow, *excelize.File, error) {
	z, e := zip.OpenReader(path)
	if e != nil {
		return nil, nil, &Fault{422, "xlsx_invalid"}
	}
	if len(z.File) > 20000 {
		z.Close()
		return nil, nil, &Fault{413, "xlsx_entry_limit"}
	}
	var expanded uint64
	for _, f := range z.File {
		if f.UncompressedSize64 > 80<<20 || expanded > 80<<20-f.UncompressedSize64 {
			z.Close()
			return nil, nil, &Fault{413, "xlsx_expansion_limit"}
		}
		expanded += f.UncompressedSize64
	}
	z.Close()
	book, e := excelize.OpenFile(path, excelize.Options{UnzipSizeLimit: 80 << 20, UnzipXMLSizeLimit: 4 << 20, RawCellValue: true})
	if e != nil {
		return nil, nil, &Fault{422, "xlsx_invalid"}
	}
	sheet := book.GetSheetName(0)
	iterator, e := book.Rows(sheet)
	if e != nil {
		book.Close()
		return nil, nil, e
	}
	defer iterator.Close()
	raw := [][]string{}
	for iterator.Next() {
		cells, e := iterator.Columns(excelize.Options{RawCellValue: true})
		if e != nil {
			book.Close()
			return nil, nil, e
		}
		if len(cells) > 32 {
			book.Close()
			return nil, nil, &Fault{413, "question_column_limit"}
		}
		raw = append(raw, cells)
		if len(raw) > maxImportRows+1 {
			book.Close()
			return nil, nil, &Fault{413, "question_import_limit"}
		}
	}
	if e = iterator.Error(); e != nil {
		book.Close()
		return nil, nil, e
	}
	rows, e := questionRows(raw)
	if e != nil {
		book.Close()
		return nil, nil, e
	}
	return rows, book, nil
}
func (s *Service) storeQuestionPicture(ctx context.Context, who AdminIdentity, filename string, data []byte) (string, error) {
	if s.Media == nil {
		return "", &Fault{503, "media_unavailable"}
	}
	if len(data) == 0 || len(data) > 10<<20 {
		return "", &Fault{413, "image_too_large"}
	}
	id, lease := newID(), newID()
	name := id + "-" + lease + ".source"
	path, e := s.Media.path(name)
	if e != nil {
		return "", e
	}
	if e = os.WriteFile(path, data, 0600); e != nil {
		return "", ErrStorage
	}
	defer s.Media.remove(name)
	output, e := s.Media.process(ctx, mediaJob{Media: Media{ID: id, Kind: "question", Filename: filename}, Owner: who.ID, Source: name, Lease: lease})
	if e != nil {
		return "", e
	}
	keep := false
	defer func() {
		if !keep {
			s.Media.remove(output.content)
			s.Media.remove(output.preview)
		}
	}()
	e = s.adminWrite(ctx, who, "questions", "question.image.import", "media", id, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `INSERT INTO pulse.media(id,admin_owner_id,request_id,request_hash,kind,filename,expected_bytes,expected_sha256,status,mime,bytes,width,height,content_path,preview_path) VALUES($1,$2,($1::uuid)::text,$3,'question',$4,$5,$6,'ready',$7,$8,$9,$10,$11,$12)`, id, who.ID, digest(id), filename, len(data), hex.EncodeToString(digest(string(data))), output.mime, output.bytes, output.width, output.height, output.content, output.preview)
		return e
	})
	if e != nil {
		return "", e
	}
	keep = true
	return id, nil
}
func localQuestionMedia(raw string) (string, bool) {
	u, e := url.Parse(raw)
	if e != nil {
		return "", false
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	for i := 0; i+1 < len(parts); i++ {
		if parts[i] == "media" && validID(parts[i+1]) {
			return parts[i+1], true
		}
	}
	return "", false
}
func (s *Service) ImportQuestions(ctx context.Context, who AdminIdentity, path, ext string) (map[string]any, error) {
	var rows []importRow
	var book *excelize.File
	var e error
	switch ext {
	case ".csv":
		rows, e = readQuestionCSV(path)
	case ".xls":
		rows, e = readQuestionXLS(path)
	case ".xlsx":
		rows, book, e = readQuestionXLSX(path)
	default:
		return nil, ErrInvalid
	}
	if e != nil {
		return nil, e
	}
	if book != nil {
		defer book.Close()
	}
	// Resolve all private references before changing question rows.
	for i := range rows {
		if id, ok := localQuestionMedia(rows[i].Question.ImageURL); ok {
			rows[i].Question.MediaID = id
			rows[i].Question.ImageURL = ""
			var owned bool
			e = s.Store.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pulse.media WHERE id=$1 AND admin_owner_id=$2 AND kind='question' AND status='ready')", id, who.ID).Scan(&owned)
			if e != nil {
				return nil, e
			}
			if !owned {
				return nil, ErrForbidden
			}
		}
	}
	if book != nil {
		sheet := book.GetSheetName(0)
		cells, e := book.GetPictureCells(sheet)
		if e != nil {
			return nil, e
		}
		byRow := map[int]string{}
		for _, cell := range cells {
			_, row, e := excelize.CellNameToCoordinates(cell)
			if e == nil {
				byRow[row] = cell
			}
		}
		for i := range rows {
			if rows[i].Question.ImageURL != "" || rows[i].Question.MediaID != "" {
				continue
			}
			cell := byRow[rows[i].Number]
			if cell == "" {
				continue
			}
			pictures, e := book.GetPictures(sheet, cell)
			if e != nil || len(pictures) != 1 {
				rows[i].Error = "question_picture_invalid"
				continue
			}
			p := pictures[0]
			id, e := s.storeQuestionPicture(ctx, who, "embedded"+p.Extension, p.File)
			if e != nil {
				rows[i].Error = "question_picture_invalid"
				continue
			}
			rows[i].Question.MediaID = id
		}
	}
	if ext == ".xls" {
		pictures, e := xlsEmbeddedPictures(path)
		if e != nil {
			return nil, &Fault{422, "xls_embedded_image_invalid"}
		}
		for i := range rows {
			if rows[i].Question.ImageURL != "" || rows[i].Question.MediaID != "" {
				continue
			}
			p, ok := pictures[rows[i].Number]
			if !ok {
				continue
			}
			if p.Extension == ".bmp" {
				cfg, _, e := image.DecodeConfig(bytes.NewReader(p.Data))
				if e != nil || int64(cfg.Width)*int64(cfg.Height) > maxImagePixels {
					return nil, mediaError("image_pixel_limit")
				}
				if e = s.Media.pixels.Acquire(ctx, int64(cfg.Width)*int64(cfg.Height)*16+(1<<20)); e != nil {
					return nil, e
				}
				img, _, e := image.Decode(bytes.NewReader(p.Data))
				var encoded bytes.Buffer
				if e == nil {
					e = png.Encode(&encoded, img)
				}
				s.Media.pixels.Release(int64(cfg.Width)*int64(cfg.Height)*16 + (1 << 20))
				if e != nil {
					return nil, mediaError("image_invalid")
				}
				p = embeddedPicture{".png", encoded.Bytes()}
			}
			id, e := s.storeQuestionPicture(ctx, who, "embedded"+p.Extension, p.Data)
			if e != nil {
				rows[i].Error = "question_picture_invalid"
				continue
			}
			rows[i].Question.MediaID = id
		}
	}
	created, updated := 0, 0
	failures := []any{}
	for _, row := range rows {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if row.Error != "" {
			failures = append(failures, map[string]any{"row": row.Number, "error": row.Error})
			continue
		}
		q := row.Question
		id := ""
		if q.Code != "" && validID(q.Code) {
			e = s.Store.Pool.QueryRow(ctx, "SELECT id::text,version FROM pulse.work_questions WHERE code=$1", q.Code).Scan(&id, &q.Version)
			if e != nil && !errors.Is(e, pgx.ErrNoRows) {
				return nil, e
			}
		}
		_, e = s.SaveQuestion(ctx, who, id, q)
		if e != nil {
			code := "question_invalid"
			var fault *Fault
			if errors.As(e, &fault) {
				code = fault.Code
			}
			failures = append(failures, map[string]any{"row": row.Number, "error": code})
		} else if id == "" {
			created++
		} else {
			updated++
		}
	}
	return map[string]any{"created": created, "updated": updated, "errors": failures}, nil
}
func (a *API) registerQuestionImport(mux *http.ServeMux) {
	s := a.Service
	mux.HandleFunc("POST /api/v2/admin/questions/import", a.adminWrap("questions", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		select {
		case s.importSlots <- struct{}{}:
			defer func() { <-s.importSlots }()
		default:
			return &Fault{429, "import_busy"}
		}
		_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(120 * time.Second))
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(150 * time.Second))
		r.Body = http.MaxBytesReader(w, r.Body, 80<<20)
		reader, e := r.MultipartReader()
		if e != nil {
			return ErrInvalid
		}
		part, e := reader.NextPart()
		if e != nil || part.FormName() != "file" {
			return ErrInvalid
		}
		defer part.Close()
		ext := strings.ToLower(filepath.Ext(part.FileName()))
		switch ext {
		case ".csv", ".xls", ".xlsx":
		default:
			return ErrInvalid
		}
		temp, e := os.CreateTemp("", "pulse-question-import-*")
		if e != nil {
			return ErrStorage
		}
		name := temp.Name()
		defer os.Remove(name)
		n, e := io.CopyBuffer(temp, part, make([]byte, 64<<10))
		closeErr := temp.Close()
		if e != nil || closeErr != nil || n == 0 {
			return ErrInvalid
		}
		if _, e = reader.NextPart(); !errors.Is(e, io.EOF) {
			return ErrInvalid
		}
		v, e := s.ImportQuestions(r.Context(), who, name, ext)
		if e == nil {
			writeJSON(w, 200, v)
		}
		return e
	}))
	for _, kind := range []string{"questions", "wages"} {
		module := "questions"
		if kind == "wages" {
			module = "records"
		}
		mux.HandleFunc("GET /api/v2/admin/exports/"+kind, a.adminWrap(module, false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
			return s.exportWork(w, r, kind, false)
		}))
	}
	mux.HandleFunc("GET /api/v2/admin/questions/template", a.adminWrap("questions", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		return s.exportWork(w, r, "questions", true)
	}))
}
func spreadsheetSafe(s string) string {
	if s != "" && strings.ContainsRune("=+-@\t\r", rune(s[0])) {
		return "'" + s
	}
	return s
}
func (s *Service) exportWork(w http.ResponseWriter, r *http.Request, kind string, template bool) error {
	select {
	case s.importSlots <- struct{}{}:
		defer func() { <-s.importSlots }()
	default:
		return &Fault{429, "export_busy"}
	}
	headers := []string{"question_uuid", "image_url", "correct_answer"}
	rows := [][]string{headers}
	if kind == "wages" {
		headers = []string{"record_id", "task_id", "user_id", "task_date", "employee_type", "correct_count", "unit_price", "wage", "status"}
		rows = [][]string{headers}
	}
	if !template {
		q := r.URL.Query()
		correct := q.Get("answer")
		if correct == "1" {
			correct = "true"
		} else if correct == "0" {
			correct = "false"
		}
		if correct != "" && correct != "true" && correct != "false" {
			return ErrInvalid
		}
		query := `SELECT code::text,CASE WHEN media_id IS NULL THEN image_url ELSE 'pulse-media:'||media_id::text END,CASE WHEN correct THEN '1' ELSE '0' END FROM pulse.work_questions WHERE code::text ILIKE $3 AND ($4='' OR correct::text=$4) ORDER BY code LIMIT $1 OFFSET $2`
		args := []any{10001, 0, "%" + escapeLike(q.Get("uuid")) + "%", correct}
		if kind == "wages" {
			filters, err := workRecordFilter(r)
			if err != nil {
				return err
			}
			query = `SELECT rec.id::text,task_id::text,user_id::text,task_date::text,employee_type,correct_count::text,to_char(unit_millis::numeric/1000,'FM999999990.000'),to_char(wage_millis::numeric/1000,'FM999999990.000'),rec.status FROM pulse.work_records rec JOIN pulse.users u ON u.id=rec.user_id WHERE ` + workRecordFilterSQL + ` ORDER BY task_date DESC,rec.id LIMIT $1 OFFSET $2`
			args = append([]any{10001, 0}, filters...)
		}
		data, e := s.Store.Pool.Query(r.Context(), query, args...)
		if e != nil {
			return e
		}
		for data.Next() {
			line := make([]string, len(headers))
			args := make([]any, len(line))
			for i := range line {
				args[i] = &line[i]
			}
			if e = data.Scan(args...); e != nil {
				data.Close()
				return e
			}
			for i := range line {
				line[i] = spreadsheetSafe(line[i])
			}
			rows = append(rows, line)
		}
		e = data.Err()
		data.Close()
		if e != nil {
			return e
		}
		if len(rows) > maxImportRows+1 {
			return &Fault{413, "export_limit"}
		}
	}
	format := r.URL.Query().Get("format")
	if format != "" && format != "csv" && format != "xlsx" {
		return ErrInvalid
	}
	if format == "xlsx" {
		book := excelize.NewFile()
		defer book.Close()
		sheet := book.GetSheetName(0)
		for i, line := range rows {
			cell, _ := excelize.CoordinatesToCellName(1, i+1)
			values := make([]any, len(line))
			for j, v := range line {
				values[j] = v
			}
			if e := book.SetSheetRow(sheet, cell, &values); e != nil {
				return e
			}
		}
		var output bytes.Buffer
		if e := book.Write(&output); e != nil {
			return e
		}
		w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%s.xlsx", kind))
		w.Header().Set("Cache-Control", "no-store")
		_, e := w.Write(output.Bytes())
		return e
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%s.csv", kind))
	w.Header().Set("Cache-Control", "no-store")
	writer := csv.NewWriter(w)
	for _, row := range rows {
		if e := writer.Write(row); e != nil {
			return e
		}
	}
	writer.Flush()
	return writer.Error()
}
