#include <vips/vips8>
#ifndef FARM_VIPS_BUNDLED
#include <libheif/heif.h>
#include <webp/encode.h>
#include <png.h>
#include <lcms2.h>
#endif
#include <algorithm>
#include <cstring>
#include <memory>
#include <string>

using vips::VImage;
// Opaque image handles own one VImage reference. Returned byte buffers use g_malloc;
// Rust must call fi_free exactly once. No exceptions may cross this C boundary.
static thread_local std::string last_error;
struct FiInfo { int width, height, eligible, format; };
static int fail(const std::exception &e) { last_error = e.what(); vips_error_clear(); return -1; }
extern "C" {
const char *fi_error() { return last_error.c_str(); }
const char *fi_version() {
#ifdef FARM_VIPS_BUNDLED
  return vips_version_string();
#else
  static std::string versions = std::string(vips_version_string()) + ";runtime-heif-" + heif_get_version() +
    ";runtime-webp-" + std::to_string(WebPGetEncoderVersion()) + ";runtime-png-" + png_get_libpng_ver(nullptr) +
    ";runtime-lcms-" + std::to_string(cmsGetEncodedCMMversion());
  return versions.c_str();
#endif
}
int fi_init() {
  if (VIPS_INIT("farm-image-processor")) return -1;
  vips_concurrency_set(1); vips_cache_set_max(0); return 0;
}
void fi_free(void *data) { g_free(data); }
void fi_drop(void *image) { delete static_cast<VImage *>(image); }
void *fi_load(const char *path, unsigned long long max_pixels, int edge, FiInfo *info) {
  try {
    auto src = VImage::new_from_file(path, VImage::option()->set("fail_on", VIPS_FAIL_ON_WARNING));
    if (src.width() <= 0 || src.height() <= 0 ||
        (unsigned long long)src.width() * src.height() > max_pixels) throw std::runtime_error("Pixel limit");
    if (src.get_typeof("n-pages") && src.get_int("n-pages") != 1) throw std::runtime_error("Animated image");
    std::string loader = src.get_string("vips-loader");
    info->format = loader.find("jpeg") != std::string::npos ? 1 : loader.find("png") != std::string::npos ? 2 : loader.find("webp") != std::string::npos ? 3 : loader.find("heif") != std::string::npos ? 4 : 0;
    if (!info->format) throw std::runtime_error("Unsupported format");
    if (info->format == 4 && (!src.get_typeof("heif-compression") || std::string(src.get_string("heif-compression")) != "av1")) throw std::runtime_error("Only AVIF allowed");
    bool clean = true;
    for (const char *key : {"exif-data", "icc-profile-data", "xmp-data", "iptc-data", "orientation"})
      if (src.get_typeof(key)) clean = false;
    int original_width = src.width(), original_height = src.height();
    bool srgb = src.interpretation() == VIPS_INTERPRETATION_sRGB;
    auto normalized = src.autorot();
    const auto interpretation = normalized.interpretation();
    const bool sixteen = interpretation == VIPS_INTERPRETATION_RGB16 || interpretation == VIPS_INTERPRETATION_GREY16;
    if (src.get_typeof("icc-profile-data") && interpretation != VIPS_INTERPRETATION_LABS && interpretation != VIPS_INTERPRETATION_GREY16) {
      try {
        normalized = normalized.icc_transform(sixteen ? "p3" : "srgb", VImage::option()->set("embedded", true)->set("depth", sixteen ? 16 : 8)->set("intent", VIPS_INTENT_PERCEPTUAL));
      } catch (const vips::VError &) { vips_error_clear(); }
    } else if (interpretation == VIPS_INTERPRETATION_CMYK) {
      normalized = normalized.icc_transform("srgb", VImage::option()->set("input_profile", "cmyk")->set("intent", VIPS_INTENT_PERCEPTUAL));
    }
    if (edge > 0 && std::max(normalized.width(), normalized.height()) > edge) {
      bool alpha = normalized.has_alpha();
      auto format = normalized.format();
      double shrink = (double)std::max(normalized.width(), normalized.height()) / edge;
      double scale_x = 1.0 / std::min(shrink, (double)normalized.width());
      double scale_y = 1.0 / std::min(shrink, (double)normalized.height());
      if (alpha) normalized = normalized.premultiply().cast(format);
      normalized = normalized.resize(scale_x, VImage::option()->set("vscale", scale_y)->set("kernel", VIPS_KERNEL_LANCZOS3));
      if (alpha) normalized = normalized.unpremultiply().cast(format);
    }
    normalized = normalized.colourspace(VIPS_INTERPRETATION_sRGB);
    // Materialize once. Encoding to default 8-bit PNG mirrors the reference path.
    void *png = nullptr; size_t len = 0;
    normalized.write_to_buffer(".png", &png, &len, VImage::option()->set("strip", true)->set("bitdepth", 8));
    std::unique_ptr<void, decltype(&g_free)> owner(png, g_free);
    auto reference = VImage::new_from_buffer(png, len, "").copy_memory();
    info->width = reference.width(); info->height = reference.height();
    info->eligible = clean && srgb && original_width == info->width && original_height == info->height;
    return new VImage(reference);
  } catch (const std::exception &e) { fail(e); return nullptr; }
}
void *fi_decode(const unsigned char *bytes, size_t length) {
  try { return new VImage(VImage::new_from_buffer(bytes, length, "", VImage::option()->set("fail_on", VIPS_FAIL_ON_WARNING)).colourspace(VIPS_INTERPRETATION_sRGB).copy_memory()); }
  catch (const std::exception &e) { fail(e); return nullptr; }
}
int fi_encode(void *image, int format, int quality, int effort, void **bytes, size_t *length) {
  try {
    auto img = *static_cast<VImage *>(image);
    if (format == 2) img.write_to_buffer(".png", bytes, length, VImage::option()->set("strip", true)->set("compression", 6)->set("filter", VIPS_FOREIGN_PNG_FILTER_NONE)->set("bitdepth", 8));
    else if (format == 1) img.write_to_buffer(".jpg", bytes, length, VImage::option()->set("strip", true)->set("Q", quality));
    else if (format == 3) img.write_to_buffer(".webp", bytes, length, VImage::option()->set("strip", true)->set("Q", quality)->set("effort", effort)->set("alpha_q", 100));
    else if (format == 4) img.write_to_buffer(".avif", bytes, length, VImage::option()->set("strip", true)->set("Q", quality)->set("effort", effort)->set("compression", VIPS_FOREIGN_HEIF_COMPRESSION_AV1)->set("subsample_mode", VIPS_FOREIGN_SUBSAMPLE_OFF));
    else throw std::runtime_error("Unsupported output format");
    return 0;
  } catch (const std::exception &e) { return fail(e); }
}
int fi_rgba(void *image, void **bytes, size_t *length, int *width, int *height) {
  try {
    auto img = *static_cast<VImage *>(image);
    if (!img.has_alpha()) img = img.bandjoin(255.0);
    img = img.cast(VIPS_FORMAT_UCHAR);
    if (img.bands() != 4) throw std::runtime_error("Invalid RGBA layout");
    *width = img.width(); *height = img.height(); *bytes = img.write_to_memory(length); return 0;
  } catch (const std::exception &e) { return fail(e); }
}
int fi_composite(void *image, int background, const char *path) {
  try {
    auto img = *static_cast<VImage *>(image);
    if (img.has_alpha()) img = img.flatten(VImage::option()->set("background", std::vector<double>{(double)background, (double)background, (double)background}));
    img.write_to_file(path, VImage::option()->set("strip", true)); return 0;
  } catch (const std::exception &e) { return fail(e); }
}
void *fi_fixture(int edge) {
  try { return new VImage(VImage::black(edge, edge, VImage::option()->set("bands", 3)).new_from_image({80, 130, 180}).copy(VImage::option()->set("interpretation", VIPS_INTERPRETATION_sRGB))); }
  catch (const std::exception &e) { fail(e); return nullptr; }
}
}
