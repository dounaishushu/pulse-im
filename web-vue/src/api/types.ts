export interface Profile {
  id: number;
  user_id: number;
  username: string;
  nickname: string;
  public_id: string;
  avatar_url: string;
  signature: string;
  birthday?: string;
  birthday_change_count?: number;
  gender?: string;
  internal_staff?: boolean;
  formal_employee?: boolean;
  online?: boolean;
  last_seen_hidden?: boolean;
  last_seen_at?: string;
  remark?: string;
  group_name?: string;
  is_contact?: boolean;
  can_add_friend?: boolean;
  add_friend_restriction?: string;
  blocked_by_me?: boolean;
  last_login_at?: string;
  last_login_device?: string;
  last_login_ip?: string;
  ip_location?: string;
  status?: string;
}
export interface Reply {
  id: number;
  sender_id?: number;
  sender_name?: string;
  text?: string;
  unavailable?: boolean;
}
export interface MessageBody {
  text?: string;
  poll_id?: number;
  url?: string;
  thumbnail_url?: string;
  mime?: string;
  name?: string;
  size?: number;
  width?: number;
  height?: number;
  original?: boolean;
  duration_ms?: number;
  media_pending?: boolean;
  user_id?: number;
  nickname?: string;
  username?: string;
  public_id?: string;
  reply_to_id?: number;
  reply_to?: Reply;
  request_id?: string;
  _go_wire_id?: string;
  _go_media_id?: string;
  _go_version?: string;
  _source_wire_id?: string;
  mention_user_ids?: number[];
  mention_all?: boolean;
}
export interface Message {
  id: number;
  conversation_id: number;
  sender_id: number;
  sender_name?: string;
  sender_nickname?: string;
  sender_avatar_url?: string;
  type: string;
  body: MessageBody;
  request_id?: string;
  created_at: string;
  edited_at?: string | null;
  recalled_at?: string | null;
  status?: string;
}
export interface Conversation {
  id: number;
  name: string;
  type: "direct" | "group" | "channel" | "favorites";
  avatar_url?: string;
  peer_user_id?: number;
  remark?: string;
  peer_online?: boolean | null;
  peer_last_seen_hidden?: boolean;
  my_role?: "owner" | "admin" | "member";
  can_manage?: boolean;
  can_send?: boolean;
  can_invite?: boolean;
  can_publish?: boolean;
  send_disabled_reason?: string;
  member_count?: number;
  member_limit?: number;
  is_pinned?: boolean;
  is_archived?: boolean;
  is_hidden?: boolean;
  notifications_muted?: boolean;
  folder_id?: number;
  unread_count?: number;
  unread_mention_count?: number;
  last_message?: Message | null;
  message_seq: number;
  updated_at?: string;
  membership_version?: number;
  event_seq?: string;
  state?: { personal_seq?: string; reminder?: boolean };
  cleared_before_message_id?: number;
}
export interface Group extends Conversation {
  description?: string;
  announcement?: string;
  all_muted?: boolean;
  allow_member_add_friend?: boolean;
  is_owner?: boolean;
  owner_id?: number;
  invite_code?: string;
  group_number?: string;
}
export interface Member extends Profile {
  role: "owner" | "admin" | "member";
  is_muted?: boolean;
  muted_permanent?: boolean;
  muted_until?: string;
}
export interface Page<T> {
  items: T[];
  total?: number;
  page?: number;
  size?: number;
  has_more?: boolean;
  next_before?: string;
}
export interface History extends Page<Message> {
  membership_version: number;
  cleared_before_message_id: number;
  snapshot_max_id: number;
}
export interface Cursor {
  events: number;
  personal: number;
  membership: number;
}
export interface Delta {
  items: Message[];
  needs_snapshot: boolean;
  cursor: Cursor;
  cleared_before_message_id: number;
}
export interface Folder {
  id: number;
  name: string;
  scope: "direct" | "groups";
  collapsed: boolean;
  conversation_ids: number[];
}
export interface LoginSession {
  id: number;
  device_type: string;
  device_name?: string;
  created_at: string;
  last_used_at: string;
  is_current: boolean;
}
export interface FriendRequest {
  id: number;
  user_id: number;
  nickname: string;
  message?: string;
  status?: string;
  created_at?: string;
}
export interface Notification {
  id: number;
  kind?: string;
  type?: string;
  body?: string;
  title?: string;
  actor_name?: string;
  created_at?: string;
  unread: boolean;
  request_id?: number;
  request_status?: string;
  conversation_id?: number;
}
export interface Uploaded {
  id: string;
  url: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  original?: boolean;
}
export interface UploadProgress {
  stage?: string;
  sent?: number;
  total?: number;
}
export interface Packet {
  type: string;
  conversation_id?: string;
  status?: number;
}
export const textOf = (message?: Message | null) =>
  !message
    ? "暂无消息"
    : message.status === "recalled"
      ? "消息已撤回"
      : message.body.text ||
        {
          image: "[图片]",
          video: "[视频]",
          voice: "[语音]",
          file: "[文件]",
          contact_card: "[名片]",
          shake: "[窗口抖动]",
        }[message.type] ||
        "[消息]";
