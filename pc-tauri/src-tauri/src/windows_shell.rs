use std::ffi::OsStr;

#[cfg(windows)]
pub(crate) fn open(target: &OsStr) -> bool {
    use std::{
        os::windows::ffi::OsStrExt,
        ptr::{null, null_mut},
    };
    use windows_sys::{
        core::w,
        Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
    };
    let target: Vec<_> = target.encode_wide().chain(std::iter::once(0)).collect();
    if target[..target.len() - 1].contains(&0) {
        return false;
    }
    let result = unsafe {
        ShellExecuteW(
            null_mut(),
            w!("open"),
            target.as_ptr(),
            null(),
            null(),
            SW_SHOWNORMAL,
        )
    };
    result as isize > 32
}

#[cfg(not(windows))]
pub(crate) fn open(_: &OsStr) -> bool {
    false
}
