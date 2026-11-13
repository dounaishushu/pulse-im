package core

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"github.com/jackc/pgx/v5"
	"os"
)

type registrationAvatar struct {
	id, source string
	output     mediaOutput
	keep       bool
	size       int64
	checksum   string
}

func (s *Service) prepareRegistrationAvatar(ctx context.Context, uid, name, encoded string) (*registrationAvatar, func(), error) {
	noop := func() {}
	if encoded == "" {
		return nil, noop, nil
	}
	if s.Media == nil {
		return nil, noop, &Fault{503, "media_unavailable"}
	}
	if base64.StdEncoding.DecodedLen(len(encoded)) > 10<<20 {
		return nil, noop, &Fault{413, "avatar_too_large"}
	}
	raw, e := base64.StdEncoding.DecodeString(encoded)
	if e != nil || len(raw) == 0 {
		return nil, noop, ErrInvalid
	}
	id, lease := newID(), newID()
	a := &registrationAvatar{id: id, source: id + "-" + lease + ".source", size: int64(len(raw)), checksum: hex.EncodeToString(digest(string(raw)))}
	cleanup := func() {
		s.Media.remove(a.source)
		if !a.keep {
			s.Media.remove(a.output.content)
			s.Media.remove(a.output.preview)
		}
	}
	path, e := s.Media.path(a.source)
	if e != nil {
		return nil, noop, e
	}
	if e = os.WriteFile(path, raw, 0600); e != nil {
		return nil, cleanup, ErrStorage
	}
	output, e := s.Media.process(ctx, mediaJob{Media: Media{ID: id, Kind: "avatar", Filename: name}, Source: a.source, Lease: lease, Owner: uid})
	a.output = output
	if e != nil {
		cleanup()
		return nil, noop, e
	}
	return a, cleanup, nil
}
func insertRegistrationAvatar(ctx context.Context, tx pgx.Tx, uid string, a registrationAvatar) error {
	_, e := tx.Exec(ctx, `INSERT INTO pulse.media(id,owner_id,request_id,request_hash,kind,filename,expected_bytes,expected_sha256,status,mime,bytes,width,height,content_path,preview_path,compression_applied) VALUES($1,$2,'registration-avatar',$3,'avatar','avatar',$4,$5,'ready',$6,$7,$8,$9,$10,$11,true)`, a.id, uid, digest(a.id), a.size, a.checksum, a.output.mime, a.output.bytes, a.output.width, a.output.height, a.output.content, a.output.preview)
	if e != nil {
		return e
	}
	_, e = tx.Exec(ctx, "UPDATE pulse.users SET avatar_id=$2 WHERE id=$1", uid, a.id)
	return e
}
