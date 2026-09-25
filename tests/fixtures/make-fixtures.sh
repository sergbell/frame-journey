#!/bin/sh
# Регенерация тестовых потоков H.264 (Annex B) для tests/h264.test.js и tests/mp4.test.js.
# Потоки закоммичены; скрипт нужен, только чтобы воспроизвести их (ffmpeg + libx264).
# Итог должен оставаться < 300 КБ суммарно.
set -e
cd "$(dirname "$0")"
X="ffmpeg -hide_banner -v error -y -f lavfi"
OUT="-bsf:v h264_mp4toannexb -f h264"

# High, CABAC, без B-кадров, IDR только в начале (как сегмент из WebCodecs: 24 fps, 48 кадров)
$X -i testsrc2=size=640x360:rate=24 -frames:v 48 -c:v libx264 -profile:v high -crf 36 \
   -bf 0 -g 48 -keyint_min 48 -sc_threshold 0 $OUT high.h264

# Baseline, CAVLC, два слайса на кадр, AUD перед каждым кадром
$X -i testsrc2=size=640x360:rate=24 -frames:v 48 -c:v libx264 -profile:v baseline -crf 36 \
   -bf 0 -g 48 -keyint_min 48 -sc_threshold 0 -x264-params slices=2:aud=1 $OUT baseline.h264

# High с B-кадрами (пирамида), взвешенным предсказанием (затемнение), 3 опорными и 2 слайсами:
# ref_pic_list_modification, pred_weight_table, MMCO, composition offsets
$X -i testsrc2=size=640x360:rate=24 -vf fade=in:0:36 -frames:v 48 -c:v libx264 -profile:v high -crf 36 \
   -bf 2 -refs 3 -g 48 -keyint_min 48 -sc_threshold 0 -x264-params b-pyramid=normal:weightp=2:slices=2 $OUT bframes.h264

# MBAFF (чересстрочное кодирование): frame_mbs_only_flag = 0, field_pic_flag, delta_pic_order_cnt_bottom
$X -i testsrc2=size=320x180:rate=24 -frames:v 12 -c:v libx264 -profile:v high -crf 36 \
   -bf 2 -g 12 -keyint_min 12 -sc_threshold 0 -x264-params interlaced=1:tff=1 $OUT mbaff.h264

# High 4:4:4 Predictive, 10 бит, свои матрицы квантования в PPS (scaling_list с delta_scale)
Q4=6,13,20,27,34,12,19,26,33,11,18,25,32,10,17,24
Q8=8,13,18,23,28,33,38,43,48,12,17,22,27,32,37,42,47,11,16,21,26,31,36,41,46,10,15,20,25,30,35,40,45,9,14,19,24,29,34,39,44,49,13,18,23,28,33,38,43,48,12,17,22,27,32,37,42,47,11,16,21,26,31,36
$X -i testsrc2=size=64x64:rate=24 -frames:v 4 -pix_fmt yuv444p10le -c:v libx264 -profile:v high444 -crf 30 \
   -bf 0 -g 4 -x264-params "cqm4iy=$Q4:cqm4py=$Q4:cqm4ic=$Q4:cqm8iy=$Q8:cqm8py=$Q8" $OUT hi444.h264

# Без потерь 4:4:4: qpprime_y_zero_transform_bypass_flag = 1
$X -i testsrc2=size=48x48:rate=24 -frames:v 2 -pix_fmt yuv444p -c:v libx264 -profile:v high444 -qp 0 \
   -bf 0 -g 2 $OUT lossless.h264

ls -l *.h264
