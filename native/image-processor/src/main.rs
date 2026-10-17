use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    ffi::{CStr, CString, c_char, c_void},
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, String>;
#[repr(C)]
#[derive(Default)]
struct Info {
    width: i32,
    height: i32,
    eligible: i32,
    format: i32,
}
unsafe extern "C" {
    fn fi_init() -> i32;
    fn fi_error() -> *const c_char;
    fn fi_version() -> *const c_char;
    fn fi_free(data: *mut c_void);
    fn fi_drop(image: *mut c_void);
    fn fi_load(path: *const c_char, max_pixels: u64, edge: i32, info: *mut Info) -> *mut c_void;
    fn fi_decode(bytes: *const u8, length: usize) -> *mut c_void;
    fn fi_encode(
        image: *mut c_void,
        format: i32,
        quality: i32,
        effort: i32,
        bytes: *mut *mut c_void,
        length: *mut usize,
    ) -> i32;
    fn fi_rgba(
        image: *mut c_void,
        bytes: *mut *mut c_void,
        length: *mut usize,
        width: *mut i32,
        height: *mut i32,
    ) -> i32;
    fn fi_composite(image: *mut c_void, background: i32, path: *const c_char) -> i32;
    fn fi_fixture(edge: i32) -> *mut c_void;
}
fn native_error() -> String {
    unsafe { CStr::from_ptr(fi_error()).to_string_lossy().into_owned() }
}
fn cpath(path: &Path) -> Result<CString> {
    CString::new(path.to_str().ok_or("Invalid path")?).map_err(|_| "Invalid path".into())
}
struct Image(*mut c_void);
impl Drop for Image {
    fn drop(&mut self) {
        unsafe { fi_drop(self.0) }
    }
}
impl Image {
    fn new(pointer: *mut c_void) -> Result<Self> {
        if pointer.is_null() {
            Err(native_error())
        } else {
            Ok(Self(pointer))
        }
    }
    fn decode(bytes: &[u8]) -> Result<Self> {
        Self::new(unsafe { fi_decode(bytes.as_ptr(), bytes.len()) })
    }
    fn encode(&self, format: i32, quality: i32, effort: i32) -> Result<Vec<u8>> {
        let mut pointer = std::ptr::null_mut();
        let mut length = 0;
        if unsafe { fi_encode(self.0, format, quality, effort, &mut pointer, &mut length) } != 0 {
            return Err(native_error());
        }
        Ok(take_buffer(pointer, length))
    }
    fn rgba(&self) -> Result<(Vec<u8>, i32, i32)> {
        let mut pointer = std::ptr::null_mut();
        let mut length = 0;
        let mut width = 0;
        let mut height = 0;
        if unsafe { fi_rgba(self.0, &mut pointer, &mut length, &mut width, &mut height) } != 0 {
            return Err(native_error());
        }
        Ok((take_buffer(pointer, length), width, height))
    }
    fn composite(&self, background: i32, path: &Path) -> Result<()> {
        if unsafe { fi_composite(self.0, background, cpath(path)?.as_ptr()) } != 0 {
            Err(native_error())
        } else {
            Ok(())
        }
    }
}
fn take_buffer(pointer: *mut c_void, length: usize) -> Vec<u8> {
    // Native ownership ends after copying; image handles never borrow this allocation.
    let output = unsafe { std::slice::from_raw_parts(pointer.cast::<u8>(), length) }.to_vec();
    unsafe { fi_free(pointer) };
    output
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Policy {
    max_bytes: u64,
    max_pixels: u64,
    max_frames: u32,
    max_output: usize,
    threshold: f64,
    avif_min: i32,
    avif_max: i32,
    webp_min: i32,
    webp_max: i32,
    effort: i32,
    edge: i32,
    timeout_ms: u64,
    metric_path: PathBuf,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    protocol_version: u32,
    job_id: String,
    attempt_id: String,
    pipeline_version: String,
    source_path: PathBuf,
    work_dir: PathBuf,
    profile: String,
    policy: Policy,
}
impl Request {
    fn validate(&self) -> Result<()> {
        let p = &self.policy;
        if self.protocol_version != 1
            || self.pipeline_version.is_empty()
            || self.pipeline_version.len() > 256
            || self.job_id.is_empty()
            || self.job_id.len() > 128
            || self.attempt_id.is_empty()
            || self.attempt_id.len() > 256
            || !["avatar", "photo", "display", "preserve"].contains(&self.profile.as_str())
            || (self.profile == "preserve") != (p.edge == 0)
            || p.edge < 0
            || p.edge > 24000
            || p.max_bytes == 0
            || p.max_bytes > 100 * 1024 * 1024
            || p.max_pixels == 0
            || p.max_pixels > 100_000_000
            || p.max_frames != 1
            || p.max_output == 0
            || p.max_output > 14 * 1024 * 1024
            || !p.threshold.is_finite()
            || !(1.0..=100.0).contains(&p.threshold)
            || !(0..=6).contains(&p.effort)
            || p.timeout_ms == 0
            || p.timeout_ms > 3_600_000
            || p.avif_min < 1
            || p.avif_min > p.avif_max
            || p.avif_max > 100
            || p.webp_min < 1
            || p.webp_min > p.webp_max
            || p.webp_max > 100
            || !self.source_path.is_absolute()
            || !self.work_dir.is_absolute()
            || !p.metric_path.is_absolute()
        {
            return Err("INVALID_INPUT: invalid protocol or policy".into());
        }
        let source = fs::symlink_metadata(&self.source_path).map_err(|e| e.to_string())?;
        let work = fs::symlink_metadata(&self.work_dir).map_err(|e| e.to_string())?;
        if !source.is_file()
            || source.file_type().is_symlink()
            || !work.is_dir()
            || work.file_type().is_symlink()
            || source.len() > p.max_bytes
            || source.len() == 0
        {
            return Err("LIMIT_EXCEEDED: invalid source or work directory".into());
        }
        let source_parent = self
            .source_path
            .parent()
            .ok_or("Invalid source")?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let work_parent = self
            .work_dir
            .parent()
            .ok_or("Invalid work directory")?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if source_parent != work_parent {
            return Err("INVALID_INPUT: staging paths differ".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if work.permissions().mode() & 0o077 != 0 {
                return Err("INVALID_INPUT: work directory must be private".into());
            }
        }
        Ok(())
    }
}

fn inspect_header(bytes: &[u8]) -> Result<()> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        let mut offset = 8usize;
        while offset.checked_add(12).is_some_and(|end| end <= bytes.len()) {
            let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
            let end = offset
                .checked_add(length)
                .and_then(|v| v.checked_add(12))
                .ok_or("INVALID_INPUT: PNG overflow")?;
            if end > bytes.len() {
                return Err("INVALID_INPUT: truncated PNG".into());
            }
            if &bytes[offset + 4..offset + 8] == b"acTL" {
                return Err("ANIMATION: APNG".into());
            }
            offset = end;
        }
        return Ok(());
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Ok(());
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        let mut offset = 12usize;
        while offset.checked_add(8).is_some_and(|end| end <= bytes.len()) {
            let size =
                u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
            if [&b"ANIM"[..], &b"ANMF"[..]].contains(&&bytes[offset..offset + 4]) {
                return Err("ANIMATION: WebP".into());
            }
            offset = offset
                .checked_add(8)
                .and_then(|v| v.checked_add(size))
                .and_then(|v| v.checked_add(size & 1))
                .ok_or("INVALID_INPUT: WebP overflow")?;
            if offset > bytes.len() {
                return Err("INVALID_INPUT: truncated WebP".into());
            }
        }
        return Ok(());
    }
    if bytes.len() >= 16 && &bytes[4..8] == b"ftyp" {
        let length = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
        if length < 16 || length > bytes.len() {
            return Err("INVALID_INPUT: invalid AVIF header".into());
        }
        let brands = std::iter::once(&bytes[8..12]).chain(bytes[16..length].chunks_exact(4));
        let mut avif = false;
        for brand in brands {
            if brand == b"avis" {
                return Err("ANIMATION: AVIF".into());
            }
            avif |= brand == b"avif";
        }
        if avif {
            return Ok(());
        }
    }
    Err("UNSUPPORTED_FORMAT: use still JPEG, PNG, WebP or AVIF".into())
}

fn metric(binary: &Path, a: &Path, b: &Path, deadline: Instant) -> Result<f64> {
    let mut child = Command::new(binary)
        .args([a, b])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "METRIC_UNAVAILABLE".to_string())?;
    let stdout = child.stdout.take().ok_or("Missing metric stdout")?;
    let stderr = child.stderr.take().ok_or("Missing metric stderr")?;
    let read = |stream: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            stream.take(4097).read_to_end(&mut bytes).map(|_| bytes)
        })
    };
    let out = read(Box::new(stdout));
    let err = read(Box::new(stderr));
    let end = deadline.min(Instant::now() + Duration::from_secs(30));
    let status = loop {
        if Instant::now() >= end {
            let _ = child.kill();
            let _ = child.wait();
            let _ = out.join();
            let _ = err.join();
            return Err("TIMEOUT: metric deadline".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.to_string());
            }
        }
    };
    let output = out
        .join()
        .map_err(|_| "Metric reader failed")?
        .map_err(|e| e.to_string())?;
    let errors = err
        .join()
        .map_err(|_| "Metric reader failed")?
        .map_err(|e| e.to_string())?;
    if !status.success() || output.len() > 4096 || errors.len() > 4096 {
        return Err("METRIC_UNAVAILABLE: invalid metric output".into());
    }
    let value: f64 = String::from_utf8_lossy(&output)
        .trim()
        .parse()
        .map_err(|_| "METRIC_UNAVAILABLE: invalid score")?;
    if !value.is_finite() {
        return Err("METRIC_UNAVAILABLE: non-finite score".into());
    }
    Ok(value)
}

struct Assessment<'a> {
    reference: Vec<u8>,
    width: i32,
    height: i32,
    paths: [PathBuf; 2],
    work: &'a Path,
    metric: &'a Path,
    deadline: Instant,
    metric_ms: f64,
}
impl Assessment<'_> {
    fn score(&mut self, bytes: &[u8]) -> Result<f64> {
        // An encoder can emit an unusable candidate for a particular image. Reject
        // that candidate while retaining the independently scored lossless option.
        // Metric errors below remain fatal; they never become a quality bypass.
        let candidate = match Image::decode(bytes) {
            Ok(image) => image,
            Err(_) => return Ok(f64::NEG_INFINITY),
        };
        let (rgba, width, height) = candidate.rgba()?;
        if width != self.width || height != self.height || rgba.len() != self.reference.len() {
            return Err("INVALID_INPUT: candidate dimensions".into());
        }
        if rgba
            .iter()
            .skip(3)
            .step_by(4)
            .ne(self.reference.iter().skip(3).step_by(4))
        {
            return Ok(f64::NEG_INFINITY);
        }
        drop(rgba);
        let mut score = f64::INFINITY;
        for (i, background) in [255, 17].into_iter().enumerate() {
            let decoded = self.work.join("candidate.png");
            candidate.composite(background, &decoded)?;
            let start = Instant::now();
            let result = metric(self.metric, &self.paths[i], &decoded, self.deadline)?;
            self.metric_ms += start.elapsed().as_secs_f64() * 1000.0;
            score = score.min(result);
        }
        Ok(score)
    }
}
fn private_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())
}
fn process(request: Request) -> Result<Value> {
    request.validate()?;
    let start = Instant::now();
    let p = &request.policy;
    let deadline = start + Duration::from_millis(p.timeout_ms);
    let source = fs::read(&request.source_path).map_err(|e| e.to_string())?;
    inspect_header(&source)?;
    let mut info = Info::default();
    let reference = Image::new(unsafe {
        fi_load(
            cpath(&request.source_path)?.as_ptr(),
            p.max_pixels,
            p.edge,
            &mut info,
        )
    })?;
    let normalized = reference.encode(2, 100, p.effort)?;
    let (rgba, width, height) = reference.rgba()?;
    let paths = [
        request.work_dir.join("reference-white.png"),
        request.work_dir.join("reference-dark.png"),
    ];
    for (path, bg) in paths.iter().zip([255, 17]) {
        reference.composite(bg, path)?;
    }
    let normalize_ms = start.elapsed().as_secs_f64() * 1000.0;
    let mut assessment = Assessment {
        reference: rgba,
        width,
        height,
        paths,
        work: &request.work_dir,
        metric: &p.metric_path,
        deadline,
        metric_ms: 0.0,
    };
    let mut best: Option<(Vec<u8>, i32, f64)> = None;
    let mut evaluated = Vec::new();
    let mut encode_ms = 0.0;
    let mut evaluate = |bytes: Vec<u8>, format: i32, quality: Option<i32>| -> Result<f64> {
        if Instant::now() >= deadline {
            return Err("TIMEOUT".into());
        }
        let score = assessment.score(&bytes)?;
        evaluated.push(json!({ "mime": mime(format), "quality": quality, "byteLength": bytes.len(), "score": if score.is_finite() { Some(score) } else { None } }));
        if score >= p.threshold
            && bytes.len() <= p.max_output
            && best
                .as_ref()
                .is_none_or(|(current, _, _)| bytes.len() < current.len())
        {
            best = Some((bytes, format, score));
        }
        Ok(score)
    };
    evaluate(normalized, 2, None)?;
    if request.profile != "preserve" {
        for (format, mut low, mut high) in
            [(4, p.avif_min, p.avif_max), (3, p.webp_min, p.webp_max)]
        {
            for _ in 0..3 {
                if low > high {
                    break;
                }
                let quality = (low + high + 1) / 2;
                let began = Instant::now();
                let bytes = match reference.encode(format, quality, p.effort) {
                    Ok(bytes) => bytes,
                    Err(_) => {
                        eprintln!("Codec rejected a candidate; retaining verified alternatives");
                        break;
                    }
                };
                encode_ms += began.elapsed().as_secs_f64() * 1000.0;
                if evaluate(bytes, format, Some(quality))? >= p.threshold {
                    high = quality - 1;
                } else {
                    low = quality + 1;
                }
            }
        }
    }
    if info.eligible != 0 && (request.profile != "preserve" || info.format == 2) {
        evaluate(source, info.format, None)?;
    }
    let (bytes, format, score) =
        best.ok_or("QUALITY_REJECTED: no passing candidate within storage limit")?;
    private_write(&request.work_dir.join("output.tmp"), &bytes)?;
    fs::rename(
        request.work_dir.join("output.tmp"),
        request.work_dir.join("output"),
    )
    .map_err(|e| e.to_string())?;
    Ok(
        json!({"protocolVersion":1,"ok":true,"pipelineVersion":request.pipeline_version,"mime":mime(format),"width":width,"height":height,
        "byteLength":bytes.len(),"sha256":format!("{:x}", Sha256::digest(&bytes)),"score":score,"evaluated":evaluated,
        "timingsMs":{"normalize":normalize_ms,"encode":encode_ms,"metric":assessment.metric_ms,"total":start.elapsed().as_secs_f64()*1000.0}}),
    )
}
fn mime(format: i32) -> &'static str {
    match format {
        1 => "image/jpeg",
        2 => "image/png",
        3 => "image/webp",
        4 => "image/avif",
        _ => "invalid",
    }
}

fn self_test() -> Result<Value> {
    let metric_path =
        PathBuf::from(std::env::var("SSIMULACRA2_BIN").map_err(|_| "METRIC_UNAVAILABLE")?);
    let work = std::env::temp_dir().join(format!("farm-image-self-test-{}", std::process::id()));
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&work)
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    fs::create_dir(&work).map_err(|e| e.to_string())?;
    let result = (|| {
        let fixture = Image::new(unsafe { fi_fixture(8) })?;
        for format in 1..=4 {
            let bytes = fixture.encode(format, 80, 0)?;
            let _ = Image::decode(&bytes)?.rgba()?;
        }
        let path = work.join("fixture.png");
        fixture.composite(255, &path)?;
        let score = metric(
            &metric_path,
            &path,
            &path,
            Instant::now() + Duration::from_secs(20),
        )?;
        if (score - 100.0).abs() > 0.01 {
            return Err("METRIC_UNAVAILABLE: incorrect self score".into());
        }
        let version = unsafe { CStr::from_ptr(fi_version()).to_string_lossy() };
        Ok(
            json!({"protocolVersion":1,"ok":true,"buildVersion":env!("CARGO_PKG_VERSION"),"nativeVersions":format!("runtime-vips-{version};{};libjxl-0.11.1",env!("FARM_NATIVE_BUILD"))}),
        )
    })();
    let _ = fs::remove_dir_all(work);
    result
}
fn run() -> Result<Value> {
    // Bound this child and inherited metric allocations separately from the API heap.
    #[cfg(unix)]
    unsafe {
        let limit = libc::rlimit {
            rlim_cur: 1536 * 1024 * 1024,
            rlim_max: 1536 * 1024 * 1024,
        };
        if libc::setrlimit(libc::RLIMIT_AS, &limit) != 0 {
            return Err("INTERNAL: resource limit unavailable".into());
        }
    }
    if unsafe { fi_init() } != 0 {
        return Err("INTERNAL: libvips initialization".into());
    }
    if std::env::args().nth(1).as_deref() == Some("--self-test") {
        return self_test();
    }
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(16385)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 16384 {
        return Err("INVALID_INPUT: oversized request".into());
    }
    process(serde_json::from_slice(&bytes).map_err(|_| "INVALID_INPUT: invalid request")?)
}
fn main() {
    match run() {
        Ok(result) => println!("{result}"),
        Err(error) => {
            eprintln!("Image processing failed: {error}");
            let code = error
                .split(':')
                .next()
                .filter(|v| {
                    [
                        "INVALID_INPUT",
                        "UNSUPPORTED_FORMAT",
                        "ANIMATION",
                        "LIMIT_EXCEEDED",
                        "QUALITY_REJECTED",
                        "METRIC_UNAVAILABLE",
                        "TIMEOUT",
                    ]
                    .contains(v)
                })
                .unwrap_or("INTERNAL");
            println!(
                "{}",
                json!({"protocolVersion":1,"ok":false,"code":code,"message":"Image processing failed"})
            );
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_codecs_roundtrip() {
        assert_eq!(unsafe { fi_init() }, 0);
        for edge in [8, 64] {
            let fixture = Image::new(unsafe { fi_fixture(edge) }).unwrap();
            for format in 1..=4 {
                let bytes = fixture.encode(format, 80, 0).unwrap();
                inspect_header(&bytes).unwrap();
                let (_, width, height) = Image::decode(&bytes).unwrap().rgba().unwrap();
                assert_eq!((width, height), (edge, edge));
            }
        }
    }
    #[test]
    fn rejects_animation_and_spoofs() {
        assert!(inspect_header(b"<svg/>").is_err());
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend_from_slice(&[0, 0, 0, 0]);
        png.extend_from_slice(b"acTL");
        png.extend_from_slice(&[0; 4]);
        assert!(inspect_header(&png).unwrap_err().starts_with("ANIMATION"));
        assert!(inspect_header(b"\0\0\0\x10ftypavis\0\0\0\0").is_err());
    }
    #[test]
    fn corrupt_headers_never_panic() {
        let mut state = 12345u32;
        for size in 0..2048 {
            let mut bytes = Vec::with_capacity(size);
            for _ in 0..size {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                bytes.push(state as u8);
            }
            let _ = inspect_header(&bytes);
        }
        for length in [0u32, 1, 7, 100, u32::MAX] {
            let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
            bytes.extend_from_slice(&length.to_be_bytes());
            bytes.extend_from_slice(b"IDAT0000");
            let _ = inspect_header(&bytes);
        }
    }
}
