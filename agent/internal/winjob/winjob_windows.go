//go:build windows

// Package winjob 은 Windows Job Object 로 프로세스 트리를 한 번에 정리한다.
//
// 자식 프로세스를 CREATE_SUSPENDED 로 띄운 뒤 Job 에 넣고 재개하므로,
// 할당 전에 손자 프로세스가 생겨 Job 밖으로 빠져나가는 틈이 없다.
// Go 의 os/exec 는 주 스레드 핸들을 주지 않으므로 재개는 ntdll 의 NtResumeProcess 로 한다.
package winjob

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// CreationFlags 는 Job 에 넣을 프로세스를 띄울 때 SysProcAttr.CreationFlags 에 더한다.
const CreationFlags = windows.CREATE_SUSPENDED

var ntResumeProcess = windows.NewLazySystemDLL("ntdll.dll").NewProc("NtResumeProcess")

// Job 은 KILL_ON_JOB_CLOSE 가 걸린 Job Object 다. Close 하면 남은 프로세스가 모두 종료된다.
type Job struct {
	h windows.Handle
}

func New() (*Job, error) {
	h, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, fmt.Errorf("CreateJobObject: %w", err)
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
			LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
		},
	}
	if _, err := windows.SetInformationJobObject(
		h,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	); err != nil {
		windows.CloseHandle(h)
		return nil, fmt.Errorf("SetInformationJobObject: %w", err)
	}
	return &Job{h: h}, nil
}

// AssignAndResume 은 CREATE_SUSPENDED 로 띄운 프로세스를 Job 에 넣고 실행을 재개한다.
func (j *Job) AssignAndResume(pid int) error {
	p, err := windows.OpenProcess(
		windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE|windows.PROCESS_SUSPEND_RESUME,
		false, uint32(pid),
	)
	if err != nil {
		return fmt.Errorf("OpenProcess: %w", err)
	}
	defer windows.CloseHandle(p)
	if err := windows.AssignProcessToJobObject(j.h, p); err != nil {
		return fmt.Errorf("AssignProcessToJobObject: %w", err)
	}
	if status, _, _ := ntResumeProcess.Call(uintptr(p)); status != 0 {
		return fmt.Errorf("NtResumeProcess: NTSTATUS 0x%x", status)
	}
	return nil
}

// Terminate 는 Job 안의 모든 프로세스를 종료한다.
func (j *Job) Terminate(exitCode uint32) error {
	return windows.TerminateJobObject(j.h, exitCode)
}

func (j *Job) Close() error {
	return windows.CloseHandle(j.h)
}
