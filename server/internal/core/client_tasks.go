package core

import (
	"encoding/json"
	"net/http"
)

func (s *Service) clientTaskPage(w http.ResponseWriter, r *http.Request, who Identity) error {
	page,size,err:=clientPage(r);if err!=nil{return err}
	date:=workDate()
	var formal bool
	if err=s.Store.Pool.QueryRow(r.Context(),"SELECT formal_employee FROM pulse.users WHERE id=$1 AND active",who.UserID).Scan(&formal);err!=nil{return err}
	rows,err:=s.Store.Pool.Query(r.Context(),`SELECT (to_jsonb(t)-'intern_millis'-'formal_millis')||jsonb_build_object(
	 'version',t.version::text,'record_id',rec.id,'record_status',rec.status,'task_date',$3::text,
	 'employee_type',CASE WHEN u.formal_employee THEN 'formal' ELSE 'intern' END,
	 'intern_unit_price',to_char(t.intern_millis::numeric/1000,'FM999999990.000'),
	 'formal_unit_price',to_char(t.formal_millis::numeric/1000,'FM999999990.000'),
	 'unit_price',to_char((CASE WHEN u.formal_employee THEN t.formal_millis ELSE t.intern_millis END)::numeric/1000,'FM999999990.000'),
	 'record',CASE WHEN rec.id IS NULL THEN NULL ELSE (to_jsonb(rec)-'questions'-'answers'-'results'-'review_hash')||jsonb_build_object(
	 'version',rec.version::text,'task_name',t.name,'nickname',u.nickname,'avatar_id',COALESCE(u.avatar_id::text,''),
	 'unit_price',to_char(rec.unit_millis::numeric/1000,'FM999999990.000'),'wage',to_char(rec.wage_millis::numeric/1000,'FM999999990.000')) END)
	 FROM pulse.work_tasks t JOIN pulse.users u ON u.id=$4 LEFT JOIN pulse.work_records rec
	 ON rec.task_id=t.id AND rec.user_id=u.id AND rec.task_date=$3::date
	 WHERE t.enabled ORDER BY t.sort_order,t.id LIMIT $1 OFFSET $2`,size,(page-1)*size,date,who.UserID)
	if err!=nil{return err}
	items:=[]json.RawMessage{}
	for rows.Next(){var item []byte;if err=rows.Scan(&item);err!=nil{rows.Close();return err};items=append(items,item)}
	err=rows.Err();rows.Close();if err!=nil{return err}
	var total int
	if err=s.Store.Pool.QueryRow(r.Context(),"SELECT count(*) FROM pulse.work_tasks WHERE enabled").Scan(&total);err!=nil{return err}
	employee:="intern";if formal{employee="formal"}
	writeJSON(w,200,map[string]any{"items":items,"date":date,"task_date":date,"employee_type":employee,"page":page,"size":size,"total":total,"has_more":page*size<total})
	return nil
}
