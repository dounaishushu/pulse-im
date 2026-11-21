#[cfg(windows)]
mod windows {
    use std::{ptr, slice};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    use zeroize::{Zeroize, Zeroizing};

    fn input(bytes: &[u8]) -> Option<CRYPT_INTEGER_BLOB> {
        Some(CRYPT_INTEGER_BLOB {
            cbData: bytes.len().try_into().ok()?,
            pbData: bytes.as_ptr().cast_mut(),
        })
    }

    pub fn seal(plain: &[u8], context: &[u8]) -> Option<Vec<u8>> {
        let plain = input(plain)?;
        let entropy = input(context)?;
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };
        let result = unsafe {
            CryptProtectData(
                &plain,
                ptr::null(),
                &entropy,
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if result == 0 || output.pbData.is_null() {
            return None;
        }
        let mut data = Vec::new();
        unsafe {
            data.extend_from_slice(slice::from_raw_parts(output.pbData, output.cbData as usize));
            LocalFree(output.pbData.cast());
        }
        Some(data)
    }

    pub fn unseal(encrypted: &[u8], context: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
        let encrypted = input(encrypted)?;
        let entropy = input(context)?;
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };
        let result = unsafe {
            CryptUnprotectData(
                &encrypted,
                ptr::null_mut(),
                &entropy,
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if result == 0 || output.pbData.is_null() {
            return None;
        }
        let mut data = Zeroizing::new(Vec::new());
        unsafe {
            let bytes = slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
            data.extend_from_slice(bytes);
            bytes.zeroize();
            LocalFree(output.pbData.cast());
        }
        Some(data)
    }
}

#[cfg(windows)]
pub(crate) use windows::{seal, unseal};

#[cfg(not(windows))]
pub(crate) fn seal(_: &[u8], _: &[u8]) -> Option<Vec<u8>> {
    None
}
#[cfg(not(windows))]
pub(crate) fn unseal(_: &[u8], _: &[u8]) -> Option<zeroize::Zeroizing<Vec<u8>>> {
    None
}
