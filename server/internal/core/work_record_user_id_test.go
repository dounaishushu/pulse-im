package core

import (
	"bytes"
	"encoding/csv"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/xuri/excelize/v2"
)

func TestWorkRecordUserIDFilterFormats(t *testing.T) {
	const long = "7762E6A7684E401BB9795C42AE528303"
	const wire = "7762e6a7-684e-401b-b979-5c42ae528303"
	for _, tc := range []struct {
		name, input, want string
		valid             bool
	}{
		{"long uppercase", long, wire, true},
		{"long lowercase", strings.ToLower(long), wire, true},
		{"pasted long ID", " \t" + long + "\n", wire, true},
		{"UUID", wire, wire, true},
		{"uppercase UUID", strings.ToUpper(wire), wire, true},
		{"legacy numeric", "517", "517", true},
		{"empty", "", "", true},
		{"non-hex long", "7762E6A7684E401BB9795C42AE52830Z", "", false},
		{"truncated long", long[:31], "", false},
		{"SQL fragment", "' OR 1=1 --", "", false},
		{"exponent", "7.762e31", "", false},
		{"zero numeric", "0", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/?user_id="+url.QueryEscape(tc.input), nil)
			filters, err := workRecordFilter(r)
			if !tc.valid {
				if err == nil {
					t.Fatal("invalid user filter accepted", filters)
				}
				return
			}
			if err != nil || filters[0] != tc.want {
				t.Fatal("wrong normalized user ID", filters, err)
			}
		})
	}
}

func recordUserIDFixture(t *testing.T) (*fixture, *adminClient, WorkRecord) {
	t.Helper()
	f := newFixture(t)
	admin := newAdmin(t, f)
	for _, answer := range []bool{true, false} {
		if _, err := f.service.SaveQuestion(f.ctx, admin.who, "", WorkQuestion{ImageURL: "https://example.invalid/record-id.png", Correct: &answer}); err != nil {
			t.Fatal(err)
		}
	}
	task, err := f.service.SaveWorkTask(f.ctx, admin.who, "", WorkTaskInput{Key: "record_ids", Name: "作业 ID 测试", OpenTime: "00:00", Estimated: 1, Questions: 2, Intern: "0.402", Formal: "1.000", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	code, err := f.service.TaskCode(f.ctx, admin.who, task, workDate(), false)
	if err != nil {
		t.Fatal(err)
	}
	var record WorkRecord
	for _, actor := range []Login{f.bob, f.alice} {
		record, err = f.service.StartTask(f.ctx, actor.Identity, task, code)
		if err != nil {
			t.Fatal(err)
		}
	}
	// A retained short public ID and an imported numeric ID must not replace the
	// requested canonical 32-character public user ID on this page.
	f.exec(t, "UPDATE pulse.users SET legacy_public_id='ShortPub12345678' WHERE id=$1", f.alice.UserID)
	f.exec(t, "INSERT INTO pulse.legacy_ids(entity,legacy_id,new_id) VALUES('user',517,$1)", f.alice.UserID)
	return f, admin, record
}

func TestWorkRecordUserIDListDetailAndFiltersStayConsistent(t *testing.T) {
	f, admin, record := recordUserIDFixture(t)
	public := strings.ToUpper(strings.ReplaceAll(f.alice.UserID, "-", ""))
	for _, filter := range []string{public, strings.ToLower(public), " " + public + " ", f.alice.UserID, "517"} {
		var page struct {
			Items []WorkRecord `json:"items"`
		}
		admin.request(t, "GET", "/api/v2/admin/task-records?user_id="+url.QueryEscape(filter)+"&task_id="+record.TaskID+"&status=in_progress&date_from="+workDate()+"&date_to="+workDate(), nil, 200, &page)
		if len(page.Items) != 1 || page.Items[0].ID != record.ID || page.Items[0].UserID != f.alice.UserID || page.Items[0].UserPublicID != public {
			t.Fatalf("list ID/filter mismatch for %q: %+v", filter, page)
		}
	}
	var detail WorkRecord
	admin.request(t, "GET", "/api/v2/admin/task-records/"+record.ID, nil, 200, &detail)
	if detail.ID != record.ID || detail.UserID != f.alice.UserID || detail.UserPublicID != public || detail.TaskID != record.TaskID {
		t.Fatalf("detail changed internal references or displayed another ID: %+v", detail)
	}
	f.request(t, "GET", "/api/v2/task-records/"+record.ID, f.alice.Token, nil, 200, &detail)
	if detail.UserPublicID != public {
		t.Fatal("owner record was not compatible with the additional display field")
	}
	f.request(t, "GET", "/api/v2/task-records/"+record.ID, f.bob.Token, nil, 403, nil)
	admin.request(t, "GET", "/api/v2/admin/task-records?user_id=not-an-id", nil, 400, nil)
	var absent struct {
		Items []WorkRecord `json:"items"`
	}
	admin.request(t, "GET", "/api/v2/admin/task-records?user_id="+strings.Repeat("F", 32), nil, 200, &absent)
	if len(absent.Items) != 0 {
		t.Fatal("unknown long ID broadened the filter")
	}
}

func recordIDExport(t *testing.T, f *fixture, admin *adminClient, public, format string) []byte {
	t.Helper()
	req, err := http.NewRequest("GET", f.http.URL+"/api/v2/admin/exports/wages?user_id="+url.QueryEscape(public)+"&format="+format, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(admin.cookie)
	req.Header.Set("X-Admin-Entry", admin.entry)
	response, err := f.http.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != 200 {
		t.Fatal("export failed", response.StatusCode, string(data), err)
	}
	return data
}

func TestWorkRecordUserIDCSVAndXLSXExportUseLongTextIDs(t *testing.T) {
	f, admin, record := recordUserIDFixture(t)
	// Numeric-only long IDs must remain text, with every digit intact in Excel.
	const numericWire = "12345678-1234-4234-8234-123456781234"
	const numericPublic = "12345678123442348234123456781234"
	f.exec(t, "INSERT INTO pulse.users(id,account,password_hash) VALUES($1,'numericrecord01',$2)", numericWire, testPasswordHash)
	f.exec(t, `INSERT INTO pulse.work_records(id,task_id,user_id,task_date,employee_type,unit_millis,questions,total)
		SELECT $1,task_id,$2,task_date,employee_type,unit_millis,questions,total FROM pulse.work_records WHERE id=$3`, newID(), numericWire, record.ID)
	for _, public := range []string{strings.ToUpper(strings.ReplaceAll(f.alice.UserID, "-", "")), numericPublic} {
		csvRows, err := csv.NewReader(bytes.NewReader(recordIDExport(t, f, admin, public, "csv"))).ReadAll()
		if err != nil || len(csvRows) != 2 || csvRows[0][2] != "user_id" || csvRows[1][2] != public {
			t.Fatal("CSV user ID mismatch or widened filter", csvRows, err)
		}
		book, err := excelize.OpenReader(bytes.NewReader(recordIDExport(t, f, admin, public, "xlsx")))
		if err != nil {
			t.Fatal(err)
		}
		sheet := book.GetSheetName(0)
		rows, err := book.GetRows(sheet)
		if err != nil || len(rows) != 2 || rows[1][2] != public {
			book.Close()
			t.Fatal("XLSX user ID mismatch or widened filter", rows, err)
		}
		cellType, err := book.GetCellType(sheet, "C2")
		book.Close()
		if err != nil || (cellType != excelize.CellTypeSharedString && cellType != excelize.CellTypeInlineString) {
			t.Fatal("Excel could round the long user ID", cellType, err)
		}
	}
}
