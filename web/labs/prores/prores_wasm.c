// Minimal ProRes decoder for the browser: FFmpeg's ProRes decoder only (libavcodec + libavutil),
// built for WebAssembly with wasi-sdk. One frame in, one picture out (planar YUV, 10/12-bit in 16-bit words).
#include <libavcodec/avcodec.h>
#include <stdlib.h>
#define EXPORT(name) __attribute__((export_name(#name)))
static AVCodecContext *ctx; static AVPacket *pkt; static AVFrame *frm;
EXPORT(pr_open) int pr_open(int w, int h, unsigned fourcc) {
  const AVCodec *c = avcodec_find_decoder(AV_CODEC_ID_PRORES);
  if (!c) return -1;
  ctx = avcodec_alloc_context3(c);
  ctx->width = w; ctx->height = h; ctx->codec_tag = fourcc; ctx->thread_count = 1;
  if (avcodec_open2(ctx, c, NULL) < 0) return -2;
  pkt = av_packet_alloc(); frm = av_frame_alloc();
  return 0;
}
EXPORT(pr_alloc) void *pr_alloc(int n) { return malloc(n + AV_INPUT_BUFFER_PADDING_SIZE); }
EXPORT(pr_free) void pr_free(void *p) { free(p); }
// Decodes one complete ProRes frame (the sample's bytes). Returns 0 when a picture is ready.
EXPORT(pr_decode) int pr_decode(unsigned char *data, int size) {
  av_frame_unref(frm);
  pkt->data = data; pkt->size = size;
  int r = avcodec_send_packet(ctx, pkt);
  if (r < 0) return r;
  return avcodec_receive_frame(ctx, frm);
}
EXPORT(pr_plane) unsigned char *pr_plane(int i) { return frm->data[i]; }
EXPORT(pr_linesize) int pr_linesize(int i) { return frm->linesize[i]; }
EXPORT(pr_width) int pr_width(void) { return frm->width; }
EXPORT(pr_height) int pr_height(void) { return frm->height; }
EXPORT(pr_format) int pr_format(void) { return frm->format; }   // AVPixelFormat
EXPORT(pr_fmt_yuv422p10) int pr_fmt_yuv422p10(void) { return AV_PIX_FMT_YUV422P10LE; }
EXPORT(pr_fmt_yuv444p10) int pr_fmt_yuv444p10(void) { return AV_PIX_FMT_YUV444P10LE; }
EXPORT(pr_fmt_yuva444p10) int pr_fmt_yuva444p10(void) { return AV_PIX_FMT_YUVA444P10LE; }
EXPORT(pr_fmt_yuv422p12) int pr_fmt_yuv422p12(void) { return AV_PIX_FMT_YUV422P12LE; }
EXPORT(pr_fmt_yuv444p12) int pr_fmt_yuv444p12(void) { return AV_PIX_FMT_YUV444P12LE; }
EXPORT(pr_fmt_yuva444p12) int pr_fmt_yuva444p12(void) { return AV_PIX_FMT_YUVA444P12LE; }
