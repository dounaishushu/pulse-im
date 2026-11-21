#[cfg(not(windows))]
use tauri::AppHandle;

pub const ARGUMENT: &str = "--send-to";

#[cfg(windows)]
mod win {
    use std::{
        ffi::{OsStr, OsString},
        fs, io,
        os::windows::ffi::OsStringExt,
        path::{Path, PathBuf},
        ptr,
    };
    use tauri::AppHandle;
    use uuid::Uuid;
    use windows::{
        core::{w, Interface, HSTRING},
        Win32::{
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile,
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READ,
            },
            UI::Shell::{
                FOLDERID_SendTo, IShellLinkW, SHGetKnownFolderPath, ShellLink, KF_FLAG_DONT_VERIFY,
                SLGP_RAWPATH,
            },
        },
    };

    const DESCRIPTION: &str = "Pulse IM Windows Send To";
    const UNAVAILABLE: &str = "无法更新 Windows 的发送到菜单。";
    const CONFLICT: &str = "发送到菜单中已有同名快捷方式，请检查后再试。";

    struct Apartment;
    impl Apartment {
        fn enter() -> Result<Self, &'static str> {
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() }
                .map_err(|_| UNAVAILABLE)?;
            Ok(Self)
        }
    }
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }

    fn shortcut_path(app: &AppHandle) -> Result<PathBuf, &'static str> {
        let identifier = &app.config().identifier;
        // Preview and development installations must use different entries.
        if identifier.is_empty()
            || !identifier
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b".-_".contains(&c))
        {
            return Err(UNAVAILABLE);
        }
        let directory = unsafe {
            let value = SHGetKnownFolderPath(&FOLDERID_SendTo, KF_FLAG_DONT_VERIFY, None)
                .map_err(|_| UNAVAILABLE)?;
            let directory = PathBuf::from(OsString::from_wide(value.as_wide()));
            CoTaskMemFree(Some(value.0.cast()));
            directory
        };
        let filename = if identifier == "com.pulseim.desktop.tauri" {
            "Pulse IM (Tauri).lnk".to_owned()
        } else if identifier == "com.pulseim.desktop.preview" {
            "Pulse IM 预览.lnk".to_owned()
        } else {
            format!("Pulse IM ({identifier}).lnk")
        };
        Ok(directory.join(filename))
    }

    fn owned(path: &Path, executable: &Path) -> bool {
        let inspect = || -> windows::core::Result<bool> {
            // Read a matching .lnk as data. Never resolve or execute its target.
            let link: IShellLinkW =
                unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)? };
            let persist: IPersistFile = link.cast()?;
            let mut target = vec![0u16; 32_768];
            let mut description = [0u16; 80];
            let mut arguments = [0u16; 80];
            unsafe {
                persist.Load(&HSTRING::from(path.as_os_str()), STGM_READ)?;
                link.GetPath(&mut target, ptr::null_mut(), SLGP_RAWPATH.0 as u32)?;
                link.GetDescription(&mut description)?;
                link.GetArguments(&mut arguments)?;
            }
            Ok(equal_wide(&target, executable.as_os_str())
                && equal_wide(&description, OsStr::new(DESCRIPTION))
                && equal_wide(&arguments, OsStr::new(super::ARGUMENT)))
        };
        fs::symlink_metadata(path).is_ok_and(|value| value.is_file() && !value.is_symlink())
            && inspect().unwrap_or(false)
    }

    fn equal_wide(data: &[u16], expected: &OsStr) -> bool {
        let end = data
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(data.len());
        OsString::from_wide(&data[..end]).eq_ignore_ascii_case(expected)
    }

    pub fn enabled(app: &AppHandle) -> Result<bool, &'static str> {
        let _com = Apartment::enter()?;
        let path = shortcut_path(app)?;
        let executable = std::env::current_exe().map_err(|_| UNAVAILABLE)?;
        Ok(owned(&path, &executable))
    }

    pub fn set(app: &AppHandle, enabled: bool) -> Result<(), &'static str> {
        let _com = Apartment::enter()?;
        let path = shortcut_path(app)?;
        let executable = std::env::current_exe().map_err(|_| UNAVAILABLE)?;
        let present = match fs::symlink_metadata(&path) {
            Ok(_) if owned(&path, &executable) => true,
            Ok(_) => return if enabled { Err(CONFLICT) } else { Ok(()) },
            Err(error) if error.kind() == io::ErrorKind::NotFound => false,
            Err(_) => return Err(UNAVAILABLE),
        };
        if !enabled {
            return if present {
                fs::remove_file(&path).map_err(|_| UNAVAILABLE)
            } else {
                Ok(())
            };
        }
        if present {
            return Ok(());
        }
        let directory = path.parent().ok_or(UNAVAILABLE)?;
        fs::create_dir_all(directory).map_err(|_| UNAVAILABLE)?;
        let temporary = directory.join(format!("pulse-send-to-{}.lnk", Uuid::new_v4()));
        let create = || -> windows::core::Result<()> {
            let link: IShellLinkW =
                unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)? };
            let persist: IPersistFile = link.cast()?;
            let target = HSTRING::from(executable.as_os_str());
            unsafe {
                link.SetPath(&target)?;
                link.SetIconLocation(&target, 0)?;
                link.SetArguments(w!("--send-to"))?;
                link.SetDescription(w!("Pulse IM Windows Send To"))?;
                persist.Save(&HSTRING::from(temporary.as_os_str()), true)
            }
        };
        let result = create().map_err(|_| UNAVAILABLE).and_then(|()| {
            // A hard link claims the fixed filename without replacing any other shortcut.
            fs::hard_link(&temporary, &path).map_err(|error| {
                if error.kind() == io::ErrorKind::AlreadyExists {
                    CONFLICT
                } else {
                    UNAVAILABLE
                }
            })
        });
        let _ = fs::remove_file(temporary);
        result
    }
}

#[cfg(windows)]
pub(crate) use win::{enabled, set};

#[cfg(not(windows))]
pub(crate) fn enabled(_: &AppHandle) -> Result<bool, &'static str> {
    Ok(false)
}

#[cfg(not(windows))]
pub(crate) fn set(_: &AppHandle, _: bool) -> Result<(), &'static str> {
    Err("当前系统没有发送到菜单。")
}
