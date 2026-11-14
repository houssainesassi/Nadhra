import resource, sys, logging, traceback
mb=int(sys.argv[1]); resource.setrlimit(resource.RLIMIT_AS,(mb<<20,mb<<20))
import cv2
from rapidocr import RapidOCR
from rapidocr.utils.typings import LangRec, OCRVersion, ModelType
def eng(l): return RapidOCR(params={"Rec.lang_type":l,"Rec.ocr_version":OCRVersion.PPOCRV5,"Rec.model_type":ModelType.MOBILE,"Global.use_cls":False,"Global.log_level":"error"})
ar,la=eng(LangRec.ARABIC),eng(LangRec.LATIN)
for n in ("M01_a.jpg","M01_b.jpg"):
    img,rec=ar.preprocess_img(cv2.imread("/home/hello/Downloads/blind/e2e/read/out/plan/"+n))
    try:
        crops,det=ar.detect_and_crop(img,rec); print(n,"det boxes",0 if det.boxes is None else len(det.boxes))
        ra=ar.recognize_txt(crops); rl=la.recognize_txt(crops); print(n,"rec ok",len(ra.txts),len(rl.txts))
    except BaseException as e:
        print(n,"EXC",type(e).__name__,str(e)[:300])
