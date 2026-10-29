// Package config 는 에이전트 설정 파일을 읽고 쓴다.
package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"go.yaml.in/yaml/v3"
)

// DefaultExecOutputLimit 은 exec stdout+stderr 합계 기본 상한이다.
const DefaultExecOutputLimit = 1 << 20

// MaxExecOutputLimit 은 메시지 상한(4 MiB)에서 여유를 둔 최대값이다.
const MaxExecOutputLimit = 3 << 20

type Config struct {
	ServerURL       string `yaml:"server_url"`
	AgentID         string `yaml:"agent_id"`
	Credential      string `yaml:"credential"`
	CAFingerprint   string `yaml:"ca_fingerprint,omitempty"`
	Shell           string `yaml:"shell,omitempty"`
	ExecOutputLimit int    `yaml:"exec_output_limit,omitempty"`
}

// ErrNotEnrolled 는 설정 파일이 없거나 자격 증명이 비어 있을 때 돌려준다.
var ErrNotEnrolled = errors.New("agent is not enrolled; run `gridelta-agent enroll` first")

// DefaultPath 는 OS 별 기본 설정 파일 경로다. 에이전트는 root/SYSTEM 으로 실행한다.
func DefaultPath() string {
	if runtime.GOOS == "windows" {
		dir := os.Getenv("ProgramData")
		if dir == "" {
			dir = `C:\ProgramData`
		}
		return filepath.Join(dir, "gridelta", "agent.yaml")
	}
	return "/etc/gridelta/agent.yaml"
}

func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotEnrolled
	}
	if err != nil {
		return nil, err
	}
	var c Config
	if err := yaml.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if c.Credential == "" || c.AgentID == "" || c.ServerURL == "" {
		return nil, ErrNotEnrolled
	}
	if c.ExecOutputLimit <= 0 {
		c.ExecOutputLimit = DefaultExecOutputLimit
	}
	c.ExecOutputLimit = min(c.ExecOutputLimit, MaxExecOutputLimit)
	return &c, nil
}

// Save 는 소유자만 읽을 수 있게(0600) 원자적으로 쓴다.
func Save(path string, c *Config) error {
	data, err := yaml.Marshal(c)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".agent-*.yaml")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
