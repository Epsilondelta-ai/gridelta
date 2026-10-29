package conn

import (
	"math/rand/v2"
	"time"
)

// backoff 는 재연결 대기 시간을 계산한다. 1s 에서 두 배씩 늘려 max 에서 멈추고, full jitter 를 적용한다.
type backoff struct {
	base    time.Duration
	max     time.Duration
	attempt int
}

func newBackoff() *backoff {
	return &backoff{base: time.Second, max: 60 * time.Second}
}

func (b *backoff) next() time.Duration {
	d := b.base << min(b.attempt, 16)
	if d <= 0 || d > b.max {
		d = b.max
	}
	b.attempt++
	return rand.N(d) + time.Millisecond
}

func (b *backoff) reset() { b.attempt = 0 }
