package core

import "golang.org/x/sys/unix"

func storageFree(path string) (uint64, error) {
	var stat unix.Statfs_t
	e := unix.Statfs(path, &stat)
	return stat.Bavail * uint64(stat.Bsize), e
}
