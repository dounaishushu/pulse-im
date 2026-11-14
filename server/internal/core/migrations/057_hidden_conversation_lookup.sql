-- Sending a new message reopens only the members who hid this conversation.
-- Keep the common path independent of the number of ordinary group members.
CREATE INDEX user_states_hidden_conversation ON pulse.user_states(conversation_id,user_id) WHERE hidden;
