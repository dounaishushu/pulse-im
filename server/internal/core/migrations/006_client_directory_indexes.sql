CREATE INDEX friendships_by_high ON pulse.friendships(user_high,user_low);
CREATE INDEX friend_requests_target_page ON pulse.friend_requests(target_id,id);
CREATE INDEX friend_requests_requester_page ON pulse.friend_requests(requester_id,id);
