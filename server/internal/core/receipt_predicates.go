package core

// msg, m and st are the aliases shared by the single and batch receipt queries.
// Explicit receipts survive personal clear/delete. Watermarks are excluded for
// messages that were hidden before the member later advanced a cursor.
const receiptDeliveredPredicate = `(EXISTS (
 SELECT 1 FROM pulse.receipt_facts rf WHERE rf.message_id=msg.id AND rf.user_id=m.user_id
   AND rf.status IN ('delivered','read')) OR
 (CASE WHEN msg.imported_legacy THEN st.legacy_delivered_override_seq ELSE st.delivered_seq END >= msg.seq
  AND NOT EXISTS (SELECT 1 FROM pulse.receipt_exclusions e
   WHERE e.conversation_id=m.conversation_id AND e.user_id=m.user_id
     AND e.kind=CASE WHEN msg.imported_legacy THEN 'legacy_delivered' ELSE 'delivered' END
     AND e.first_seq<=msg.seq AND e.last_seq>=msg.seq)))`

const receiptReadPredicate = `(EXISTS (
 SELECT 1 FROM pulse.receipt_facts rf WHERE rf.message_id=msg.id AND rf.user_id=m.user_id
   AND rf.status='read') OR
 (CASE WHEN msg.imported_legacy THEN st.legacy_read_override_seq ELSE st.read_seq END >= msg.seq
  AND NOT EXISTS (SELECT 1 FROM pulse.receipt_exclusions e
   WHERE e.conversation_id=m.conversation_id AND e.user_id=m.user_id
     AND e.kind=CASE WHEN msg.imported_legacy THEN 'legacy_read' ELSE 'read' END
     AND e.first_seq<=msg.seq AND e.last_seq>=msg.seq)))`

// PHP counted stored per-message receipts even after a recipient left. The
// active-member part of the query already counts current members; these terms
// add only facts for recipients no longer in that part of the join.
const receiptOrphanBase = ` FROM pulse.receipt_facts rf WHERE rf.message_id=msg.id
 AND rf.user_id<>msg.sender_id AND NOT EXISTS (
   SELECT 1 FROM pulse.members historical_member
   WHERE historical_member.conversation_id=msg.conversation_id
     AND historical_member.user_id=rf.user_id AND historical_member.active
     AND historical_member.visible_from_seq<=msg.seq)`

const receiptOrphanRecipients = `(SELECT count(*)` + receiptOrphanBase + `)`
const receiptOrphanDelivered = `(SELECT count(*)` + receiptOrphanBase + ` AND rf.status IN ('delivered','read'))`
const receiptOrphanRead = `(SELECT count(*)` + receiptOrphanBase + ` AND rf.status='read')`
