use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{ErrorKind, Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::{
    backend::Backend,
    workspace::{group_id, is_workspace, trusted_page},
    workspace_groups,
};

const MAX_VAULT_BYTES: u64 = 256 * 1024;
const MAX_PER_SERVER: usize = 10;
const MAGIC: &[u8] = b"PULSE-TAURI-SIGNINS-V1\n";
const CONTEXT: &[u8] = b"Pulse IM Windows remembered sign-ins v1";
const READ_ERROR: &str = "本机记住的账号暂时无法读取。";
const WRITE_ERROR: &str = "无法保存此电脑上的账号设置。";

type VaultResult<T> = Result<T, &'static str>;

#[derive(Serialize, Deserialize)]
struct Entry {
    id: Uuid,
    server: String,
    account: String,
    user_id: u64,
    password: String,
}

impl Drop for Entry {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.password.zeroize();
    }
}

#[derive(Serialize)]
pub struct SignInRow {
    id: Uuid,
    account: String,
}

#[derive(Serialize)]
pub struct SignInValue {
    account: String,
    password: String,
}

impl Drop for SignInValue {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.password.zeroize();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuccessfulSignIn {
    account: String,
    user_id: u64,
    password: String,
    remember: bool,
}

pub struct SignIns {
    default: Arc<Vault>,
    groups: Mutex<HashMap<Uuid, Arc<Vault>>>,
}

struct Vault {
    path: PathBuf,
    access: Mutex<()>,
}

impl SignIns {
    pub fn new(app: &AppHandle) -> tauri::Result<Self> {
        let path = crate::storage::data(app)?.join("remembered-signins-v1.dat");
        Ok(Self {
            default: Arc::new(Vault {
                path,
                access: Mutex::new(()),
            }),
            groups: Mutex::new(HashMap::new()),
        })
    }

    async fn run<T: Send + 'static>(
        &self,
        window: &WebviewWindow,
        action: impl FnOnce(&Vault, Vec<Entry>) -> VaultResult<T> + Send + 'static,
    ) -> VaultResult<T> {
        if !is_workspace(window.label()) || !window.url().is_ok_and(|url| trusted_page(&url)) {
            return Err(READ_ERROR);
        }
        let vault = if let Some(id) = group_id(window.label()) {
            let directory =
                workspace_groups::directory(window.app_handle(), id).map_err(|_| READ_ERROR)?;
            let mut groups = self.groups.lock().map_err(|_| READ_ERROR)?;
            groups
                .entry(id)
                .or_insert_with(|| {
                    Arc::new(Vault {
                        path: directory.join("remembered-signins-v1.dat"),
                        access: Mutex::new(()),
                    })
                })
                .clone()
        } else {
            self.default.clone()
        };
        tauri::async_runtime::spawn_blocking(move || {
            let _guard = vault.access.lock().map_err(|_| READ_ERROR)?;
            let items = vault.read()?;
            action(&vault, items)
        })
        .await
        .map_err(|_| READ_ERROR)?
    }
}

impl Vault {
    fn read(&self) -> VaultResult<Vec<Entry>> {
        let file = match File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(vec![]),
            Err(_) => return Err(READ_ERROR),
        };
        let mut bytes = Vec::new();
        file.take(MAX_VAULT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| READ_ERROR)?;
        if bytes.len() as u64 > MAX_VAULT_BYTES {
            return Err(READ_ERROR);
        }
        let encrypted = bytes.strip_prefix(MAGIC).ok_or(READ_ERROR)?;
        let plain = crate::local_protection::unseal(encrypted, CONTEXT).ok_or(READ_ERROR)?;
        serde_json::from_slice(&plain).map_err(|_| READ_ERROR)
    }

    fn write(&self, items: &[Entry]) -> VaultResult<()> {
        let data = Zeroizing::new(serde_json::to_vec(items).map_err(|_| WRITE_ERROR)?);
        let encrypted = crate::local_protection::seal(&data, CONTEXT).ok_or(WRITE_ERROR)?;
        let parent = self.path.parent().ok_or(WRITE_ERROR)?;
        fs::create_dir_all(parent).map_err(|_| WRITE_ERROR)?;
        let temp = parent.join(format!("remembered-signins-{}.tmp", Uuid::new_v4()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|_| WRITE_ERROR)?;
        let written = file
            .write_all(MAGIC)
            .and_then(|_| file.write_all(&encrypted))
            .and_then(|_| file.sync_all());
        drop(file);
        let saved = written.and_then(|_| fs::rename(&temp, &self.path));
        if saved.is_err() {
            let _ = fs::remove_file(temp);
            return Err(WRITE_ERROR);
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn remembered_signins(
    window: WebviewWindow,
    vault: State<'_, SignIns>,
    backend: State<'_, Backend>,
) -> VaultResult<Vec<SignInRow>> {
    let server = backend.signin_key();
    vault
        .run(&window, move |_, items| {
            Ok(items
                .iter()
                .filter(|item| item.server == server)
                .map(|item| SignInRow {
                    id: item.id,
                    account: item.account.clone(),
                })
                .collect())
        })
        .await
}

#[tauri::command]
pub async fn read_remembered_signin(
    window: WebviewWindow,
    vault: State<'_, SignIns>,
    backend: State<'_, Backend>,
    id: Uuid,
) -> VaultResult<Option<SignInValue>> {
    let server = backend.signin_key();
    vault
        .run(&window, move |_, items| {
            Ok(items
                .iter()
                .find(|item| item.id == id && item.server == server)
                .map(|item| SignInValue {
                    account: item.account.clone(),
                    password: item.password.clone(),
                }))
        })
        .await
}

#[tauri::command]
pub async fn remember_signin(
    window: WebviewWindow,
    vault: State<'_, SignIns>,
    backend: State<'_, Backend>,
    sign_in: SuccessfulSignIn,
) -> VaultResult<()> {
    let server = backend.signin_key();
    let account = sign_in.account.trim().to_owned();
    let password = Zeroizing::new(sign_in.password);
    let user_id = sign_in.user_id;
    let remember = sign_in.remember;
    if account.is_empty()
        || account.len() > 128
        || password.is_empty()
        || password.len() > 1024
        || user_id == 0
    {
        return Err(WRITE_ERROR);
    }
    vault
        .run(&window, move |vault, mut items| {
            let before = items.len();
            items.retain(|item| {
                item.server != server
                    || (item.user_id != user_id && !item.account.eq_ignore_ascii_case(&account))
            });
            if !remember && before == items.len() {
                return Ok(());
            }
            if remember {
                items.insert(
                    0,
                    Entry {
                        id: Uuid::new_v4(),
                        user_id,
                        server: server.clone(),
                        account,
                        password: password.to_string(),
                    },
                );
            }
            let mut count = 0;
            items.retain(|item| {
                if item.server != server {
                    return true;
                }
                count += 1;
                count <= MAX_PER_SERVER
            });
            vault.write(&items)
        })
        .await
}

#[tauri::command]
pub async fn forget_remembered_signin(
    window: WebviewWindow,
    vault: State<'_, SignIns>,
    backend: State<'_, Backend>,
    id: Uuid,
) -> VaultResult<()> {
    let server = backend.signin_key();
    vault
        .run(&window, move |vault, mut items| {
            let before = items.len();
            items.retain(|item| item.server != server || item.id != id);
            if before == items.len() {
                return Ok(());
            }
            vault.write(&items)
        })
        .await
}
