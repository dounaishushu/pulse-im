// Modified for Pulse IM: ACK is bound to the authenticated socket identity.
package ws

func HeartbeatHandler(client *Client, req *Request) (interface{}, error) {
	return "heartbeat", nil
}

func AckHandler(client *Client, req *Request) (interface{}, error) {
	Manager.DeleteRetryMessage(client.UserId, client.Device, req.SeqId)
	return "success", nil
}
