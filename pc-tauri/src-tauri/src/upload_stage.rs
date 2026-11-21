use std::{collections::HashMap, path::PathBuf, sync::Arc};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{ipc::Request, AppHandle, Manager, State, WebviewWindow};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, SeekFrom},
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub const MAX_BYTES: usize = 100 * 1024 * 1024;
const CHUNK_BYTES: usize = 512 * 1024;
const MAX_STAGES: usize = 24;
const STAGE_HEADER: &str = "x-pulse-upload-stage";
const INVALID_STAGE: &str = "invalid_upload_stage";

type StageKey = (String, Uuid);

#[derive(Serialize)]
pub struct ExplorerStage {
    id: Uuid,
    sha256: String,
}

pub struct UploadStages {
    directory: PathBuf,
    stages: Mutex<HashMap<StageKey, Arc<Stage>>>,
}

struct Stage {
    expected: u64,
    authorization: [u8; 32],
    path: PathBuf,
    data: Mutex<StageData>,
    closed: CancellationToken,
}

struct StageData {
    file: Option<fs::File>,
    written: u64,
    digest: Sha256,
    sealed: Option<String>,
}

impl StageData {
    async fn copy_selected(
        &mut self,
        source: &mut fs::File,
        expected: u64,
    ) -> Result<String, &'static str> {
        const SOURCE_CHANGED: &str = "所选文件已变更或无法读取，请重新选择。";
        source
            .seek(SeekFrom::Start(0))
            .await
            .map_err(|_| SOURCE_CHANGED)?;
        let file = self.file.as_mut().ok_or(INVALID_STAGE)?;
        let mut buffer = vec![0; CHUNK_BYTES];
        while self.written < expected {
            let length = ((expected - self.written) as usize).min(buffer.len());
            let read = source
                .read(&mut buffer[..length])
                .await
                .map_err(|_| SOURCE_CHANGED)?;
            if read == 0 {
                return Err(SOURCE_CHANGED);
            }
            file.write_all(&buffer[..read])
                .await
                .map_err(|_| "upload_cache_write_failed")?;
            self.written += read as u64;
            self.digest.update(&buffer[..read]);
        }
        if source
            .read(&mut buffer[..1])
            .await
            .map_err(|_| SOURCE_CHANGED)?
            != 0
        {
            return Err(SOURCE_CHANGED);
        }
        self.seal().await
    }

    async fn seal(&mut self) -> Result<String, &'static str> {
        if let Some(digest) = &self.sealed {
            return Ok(digest.clone());
        }
        let mut file = self.file.take().ok_or(INVALID_STAGE)?;
        file.flush()
            .await
            .map_err(|_| "upload_cache_write_failed")?;
        drop(file);
        let digest = format!("{:x}", std::mem::take(&mut self.digest).finalize());
        self.sealed = Some(digest.clone());
        Ok(digest)
    }
}

impl UploadStages {
    pub fn new(app: &AppHandle) -> tauri::Result<Self> {
        let directory = crate::storage::cache(app)?.join("upload-spool-v1");
        // The single instance lock is already held before setup. Only files
        // created by this uploader in its private spool can be stale here.
        if let Ok(entries) = std::fs::read_dir(&directory) {
            for entry in entries.flatten() {
                let path = entry.path();
                if entry.file_type().is_ok_and(|kind| kind.is_file())
                    && path.extension().is_some_and(|suffix| suffix == "part")
                    && path
                        .file_stem()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| Uuid::parse_str(name).is_ok())
                {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
        Ok(Self {
            directory,
            stages: Mutex::new(HashMap::new()),
        })
    }

    async fn create(
        &self,
        label: &str,
        size: u64,
        token: &str,
        closed: CancellationToken,
    ) -> Result<Uuid, &'static str> {
        if size == 0 || size > MAX_BYTES as u64 {
            return Err("media_too_large");
        }
        let credential = format!("Bearer {token}");
        if !crate::http::valid_authorization(&credential) {
            return Err("invalid_api_authorization");
        }
        let mut stages = self.stages.lock().await;
        if closed.is_cancelled() {
            return Err(INVALID_STAGE);
        }
        if stages.len() >= MAX_STAGES {
            return Err("upload_stage_busy");
        }
        fs::create_dir_all(&self.directory)
            .await
            .map_err(|_| "upload_cache_unavailable")?;
        let id = Uuid::new_v4();
        let spool = self.directory.join(format!("{id}.part"));
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&spool)
            .await
            .map_err(|_| "upload_cache_unavailable")?;
        stages.insert(
            (label.to_owned(), id),
            Arc::new(Stage {
                expected: size,
                authorization: Sha256::digest(credential.as_bytes()).into(),
                path: spool,
                data: Mutex::new(StageData {
                    file: Some(file),
                    written: 0,
                    digest: Sha256::new(),
                    sealed: None,
                }),
                closed,
            }),
        );
        Ok(id)
    }

    pub async fn prepare_explorer(
        &self,
        label: &str,
        token: &str,
        size: u64,
        source: &mut fs::File,
        scope: CancellationToken,
    ) -> Result<ExplorerStage, &'static str> {
        let id = self.create(label, size, token, scope.child_token()).await?;
        let result = async {
            let stage = self.lookup(label, id).await?;
            let mut data = stage.data.lock().await;
            tokio::select! {
                biased;
                _ = stage.closed.cancelled() => Err(INVALID_STAGE),
                copy = data.copy_selected(source, size) => copy,
            }
        }
        .await;
        match result {
            Ok(sha256) => Ok(ExplorerStage { id, sha256 }),
            Err(error) => {
                self.remove(label, id).await;
                Err(error)
            }
        }
    }

    async fn remove(&self, label: &str, id: Uuid) {
        let stage = self.stages.lock().await.remove(&(label.to_owned(), id));
        if let Some(stage) = stage {
            release(stage).await;
        }
    }

    async fn lookup(&self, label: &str, id: Uuid) -> Result<Arc<Stage>, &'static str> {
        self.stages
            .lock()
            .await
            .get(&(label.to_owned(), id))
            .cloned()
            .ok_or(INVALID_STAGE)
    }

    pub async fn open(
        &self,
        label: &str,
        id: Uuid,
        owner: [u8; 32],
    ) -> Result<(fs::File, u64, CancellationToken), &'static str> {
        let stage = self.lookup(label, id).await?;
        if stage.authorization != owner || stage.closed.is_cancelled() {
            return Err(INVALID_STAGE);
        }
        let data = stage.data.lock().await;
        if data.sealed.is_none() {
            return Err(INVALID_STAGE);
        }
        let file = fs::File::open(&stage.path)
            .await
            .map_err(|_| INVALID_STAGE)?;
        Ok((file, stage.expected, stage.closed.clone()))
    }

    pub async fn close_window(&self, owner: &str) {
        let removed = {
            let mut stages = self.stages.lock().await;
            let keys: Vec<_> = stages
                .keys()
                .filter(|(label, _)| label == owner)
                .cloned()
                .collect();
            keys.iter()
                .filter_map(|key| stages.remove(key))
                .collect::<Vec<_>>()
        };
        for stage in removed {
            release(stage).await;
        }
    }
}

#[tauri::command]
pub async fn create_upload_stage(
    window: WebviewWindow,
    uploads: State<'_, UploadStages>,
    size: u64,
    token: String,
) -> Result<Uuid, &'static str> {
    uploads
        .create(window.label(), size, &token, CancellationToken::new())
        .await
}

#[tauri::command]
pub async fn push_upload_stage(
    window: WebviewWindow,
    uploads: State<'_, UploadStages>,
    request: Request<'_>,
) -> Result<(), &'static str> {
    let id = request
        .headers()
        .get(STAGE_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|id| Uuid::parse_str(id).ok())
        .ok_or(INVALID_STAGE)?;
    let data = match request.body() {
        tauri::ipc::InvokeBody::Raw(data) if !data.is_empty() && data.len() <= CHUNK_BYTES => data,
        _ => return Err("invalid_upload_chunk"),
    };
    let stage = uploads.lookup(window.label(), id).await?;
    let mut state = stage.data.lock().await;
    if stage.closed.is_cancelled()
        || state.sealed.is_some()
        || state.written + data.len() as u64 > stage.expected
    {
        return Err("invalid_upload_chunk");
    }
    state
        .file
        .as_mut()
        .ok_or(INVALID_STAGE)?
        .write_all(data)
        .await
        .map_err(|_| "upload_cache_write_failed")?;
    state.written += data.len() as u64;
    state.digest.update(data);
    Ok(())
}

#[tauri::command]
pub async fn seal_upload_stage(
    window: WebviewWindow,
    uploads: State<'_, UploadStages>,
    id: Uuid,
) -> Result<String, &'static str> {
    let stage = uploads.lookup(window.label(), id).await?;
    let mut state = stage.data.lock().await;
    if stage.closed.is_cancelled() || state.written != stage.expected {
        return Err(INVALID_STAGE);
    }
    state.seal().await
}

#[tauri::command]
pub async fn release_upload_stage(
    window: WebviewWindow,
    uploads: State<'_, UploadStages>,
    id: Uuid,
) -> Result<(), &'static str> {
    uploads.remove(window.label(), id).await;
    Ok(())
}

async fn release(stage: Arc<Stage>) {
    stage.closed.cancel();
    stage.data.lock().await.file.take();
    let _ = fs::remove_file(&stage.path).await;
}
