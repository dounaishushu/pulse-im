package core

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"testing"
)

func TestImageUploadAcceptsFivePointTwoMBWithAndWithoutOriginal(t *testing.T) {
	f := newFixture(t)
	enableTestMedia(t, f)
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 640, 480)), &jpeg.Options{Quality: 85}); err != nil {
		t.Fatal(err)
	}
	// Valid JPEG comment segments produce an exact 5.2 MiB file without
	// conflating transfer size with the independent image-pixel safety limit.
	const targetBytes = 5452595
	var data bytes.Buffer
	data.Write(encoded.Bytes()[:2])
	for remaining := targetBytes - encoded.Len(); remaining >= 4; {
		size := min(remaining-4, 65533)
		data.Write([]byte{0xff, 0xfe, byte((size + 2) >> 8), byte(size + 2)})
		data.Write(make([]byte, size))
		remaining -= size + 4
	}
	data.Write(encoded.Bytes()[2:])
	for data.Len() < targetBytes {
		data.WriteByte(0)
	}
	if data.Len() != targetBytes {
		t.Fatal("invalid test image size", data.Len())
	}
	sum := sha256.Sum256(data.Bytes())
	for _, original := range []bool{false, true} {
		var media Media
		f.request(t, "POST", "/api/v2/media/uploads", f.alice.Token, UploadInput{
			RequestID: newID(), Kind: "image", Filename: "5.2mb.jpg", Bytes: targetBytes, SHA256: hex.EncodeToString(sum[:]), Original: original,
		}, 201, &media)
		req, err := http.NewRequest("PUT", f.http.URL+"/api/v2/media/"+media.ID+"/bytes", bytes.NewReader(data.Bytes()))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+f.alice.Token)
		response, err := f.http.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != 202 {
			t.Fatalf("5.2 MB upload original=%v: %d %s", original, response.StatusCode, body)
		}
		if done, err := f.service.ProcessMediaOnce(f.ctx); !done || err != nil {
			t.Fatal("image processing", done, err)
		}
		f.request(t, "GET", "/api/v2/media/"+media.ID, f.alice.Token, nil, 200, &media)
		if media.Status != "ready" || media.Width != 640 || media.Height != 480 || original && media.Bytes != targetBytes {
			t.Fatalf("5.2 MB image was rejected or original bytes changed: %+v", media)
		}
		sent, err := f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: newID(), Kind: "image", MediaID: media.ID})
		if err != nil {
			t.Fatal("5.2 MB image could not be sent", err)
		}
		f.request(t, "GET", "/api/v2/conversations/"+f.cid+"/messages/"+sent.Message.ID, f.bob.Token, nil, 200, nil)
	}
}
