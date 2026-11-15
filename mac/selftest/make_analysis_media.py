#!/usr/bin/env python3
"""Test episode for the video analysis (needs ffmpeg): moving colour pictures with
  - three commercial blacks (silent, with fades), 12 frames / 1 s / 2 s
  - two blacks where the sound carries on (8 frames, 1.2 s): not commercial blacks
  - a dark night scene that isn't black, and a black head and tail
  - opening credits (14 lower-third cards ending in "Directed by"), a main title and two captions
Usage: make_analysis_media.py OUT.mp4 [WIDTHxHEIGHT]   -> also writes OUT.mp4.json (what is where).
Text: drawn by ffmpeg (drawtext) when it can; otherwise the cards are overlaid from pictures in
cards/<WIDTHxHEIGHT>/ next to this script (Homebrew's ffmpeg has no drawtext). Those pictures are made with
  make_analysis_media.py --render-cards WIDTHxHEIGHT      (needs Python's Pillow and the Inter font)
"""
import subprocess, sys, json, os
RENDER=len(sys.argv)>1 and sys.argv[1]=='--render-cards'
if RENDER: out=None; SZ=sys.argv[2] if len(sys.argv)>2 else '1280x720'
else: out=sys.argv[1]; SZ=sys.argv[2] if len(sys.argv)>2 else '1920x1080'
W,H=map(int,SZ.split('x')); R='24000/1001'
def font(*names):
    for n in names:
        if os.path.exists(n): return n
    return None
REG=font('/usr/share/fonts/opentype/inter/Inter-Regular.otf','/System/Library/Fonts/Supplemental/Arial.ttf','/Library/Fonts/Arial.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
BOLD=font('/usr/share/fonts/opentype/inter/Inter-SemiBold.otf','/System/Library/Fonts/Supplemental/Arial Bold.ttf','/Library/Fonts/Arial Bold.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf') or REG
TEXT=not os.environ.get('NO_DRAWTEXT') and bool(REG) and 'drawtext' in subprocess.run(['ffmpeg','-hide_banner','-filters'],capture_output=True,text=True).stdout
# ---- picture: scenes and full blacks, in order. ('scene', seconds, source, fade_in, fade_out) | ('black', seconds, kind)
g=lambda c,t,sp,seed: f"gradients=s={SZ}:r={R}:c0={c[0]}:c1={c[1]}:c2={c[2]}:c3={c[3]}:n=4:type={t}:speed={sp}:seed={seed}"
SC=[
 ('black',2.0,'head (silent)'),
 ('scene',36.0,g(['0x2a6f97','0xe9c46a','0x264653','0xf4a261'],'linear',0.02,1),0.5,0),     # cold open (brief black with audio inside)
 ('scene',8.0,g(['0x1d3557','0x457b9d','0x14213d','0x2b4a6b'],'radial',0.01,2),0,0),          # main title
 ('scene',52.0,g(['0x8ecae6','0xffb703','0x219ebc','0xfb8500'],'circular',0.015,3),0,0),     # credits 1
 ('scene',52.0,g(['0x606c38','0xdda15e','0x283618','0xbc6c25'],'linear',0.02,4),0,0),        # credits 2
 ('scene',50.0,g(['0xcdb4db','0xffc8dd','0x6d597a','0xb56576'],'spiral',0.01,5),0,0.6),      # scene D -> fade out
 ('black',0.5,'commercial 1 (silent)'),
 ('scene',89.5,g(['0x52b788','0xd8f3dc','0x1b4332','0x95d5b2'],'radial',0.02,6),0.6,0.6),    # scene E (black with audio inside)
 ('black',1.0,'commercial 2 (silent)'),
 ('scene',30.0,g(['0xe63946','0xf1faee','0x9d0208','0xffba08'],'linear',0.025,7),0.6,0),
 ('scene',12.0,g(['0x1b2430','0x2c3a4f','0x161d27','0x34455c'],'radial',0.01,8),0,0),         # dark night scene (not black)
 ('scene',27.0,g(['0xe63946','0xf1faee','0x9d0208','0xffba08'],'circular',0.02,9),0,0.6),
 ('black',2.0,'commercial 3 (silent)'),
 ('scene',48.0,g(['0x3a86ff','0xffbe0b','0x8338ec','0xff006e'],'spiral',0.012,10),0.6,1.0),
 ('black',2.0,'tail (silent)'),
]
fr=24000/1001
def snap(x): return round(round(x*fr)/fr,6)
t=0; parts=[]; blacks=[]; fc=[]
for i,s in enumerate(SC):
    d=snap(s[1])
    if s[0]=='black':
        fc.append(f"color=c=black:s={SZ}:r={R}:d={d},format=yuv420p[v{i}]"); blacks.append((t,t+d,s[2],'silent'))
    else:
        f=f"{s[2]},trim=duration={d},setpts=PTS-STARTPTS,format=yuv420p"
        if s[3]: f+=f",fade=t=in:st=0:d={s[3]}"
        if s[4]: f+=f",fade=t=out:st={d-s[4]}:d={s[4]}"
        fc.append(f+f"[v{i}]")
    parts.append(f"[v{i}]"); t+=d
total=t
# blacks inside a scene, sound carries on (not commercial blacks)
INNER=[(snap(20.0),snap(20.0)+snap(8/fr),'8 frames, sound carries on'),(snap(250.0),snap(250.0)+snap(1.2),'1.2 s, sound carries on')]
for a,b,k in INNER: blacks.append((a,b,k,'audio'))
blacks.sort()
chain="".join(parts)+f"concat=n={len(parts)}:v=1:a=0[vc];[vc]"
chain+=",".join(f"drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(t,{a},{b-0.001})'" for a,b,k in INNER)
# ---- text
def esc(s): return s.replace('\\','\\\\').replace(':','\\:').replace("'","\u2019").replace(',','\\,')
texts=[]; specs=[]
def card(t0,dur,lines,side,y0=0.76):
    specs.append((t0,dur,lines,side,y0))
    # lines: [(text, size_frac, bold)] ; fades 0.4 s
    y=y0
    for txt,sz,bold in lines:
        fs=int(H*sz)
        x={'left':f"{int(W*0.09)}",'right':f"w-text_w-{int(W*0.09)}",'mid':"(w-text_w)/2"}[side]
        a=f"if(lt(t,{t0+0.4}),(t-{t0})/0.4,if(gt(t,{t0+dur-0.4}),({t0+dur}-t)/0.4,1))"
        texts.append(f"drawtext=fontfile={BOLD if bold else REG}:text='{esc(txt)}':fontsize={fs}:fontcolor=white:shadowcolor=black@0.6:shadowx=2:shadowy=2:x={x}:y={int(H*y)}:alpha='{a}':enable='between(t,{t0},{t0+dur})'")
        y+=sz*1.35
    return (t0,t0+dur,' / '.join(l[0] for l in lines),side)
cards=[]
cards.append(card(27.0,3.0,[('THREE WEEKS EARLIER',0.036,False)],'left',0.80)+('caption (not a credit)',))
cards.append(card(39.5,5.0,[('HARBOR LIGHTS',0.11,True)],'mid',0.42)+('main title',))
CR=[('Starring','ELENA MARCH'),('Starring','TOMAS REY'),('Starring','JUNE ADEBAYO'),('With','PETER LANGLEY'),('And','MARGIT SOLHEIM'),
    ('Casting by','RUTH ABELARD'),('Music by','IVO KARLSSON'),('Edited by','DANA WHITLOCK'),('Production Designer','SAM OYELARAN'),
    ('Director of Photography','LENA HOLT'),('Produced by','MARK DELACROIX'),('Executive Producers','NORA FITCH   ALAN BRISCOE'),
    ('Written by','CLARE DUNMORE'),('Directed by','OSCAR VALE')]
t0=50.0
for i,(role,name) in enumerate(CR):
    side='left' if i%2==0 else 'right'
    cards.append(card(t0,3.5,[(role,0.03,False),(name,0.05,True)],side)+('credit',))
    t0+=7.0 if i!=7 else 14.0     # one longer break in the middle
cards.append(card(160.0,3.0,[('HARBOUR OFFICE — 6\u200940 AM',0.036,False)],'left',0.80)+('caption after the credits (not a credit)',))
CARDS=os.path.join(os.path.dirname(os.path.abspath(__file__)),'cards',SZ)
def card_png(i): return os.path.join(CARDS,f'card_{i:02d}.png')
if RENDER:   # the cards as pictures (transparent, full frame), for an ffmpeg without drawtext
    from PIL import Image, ImageDraw, ImageFont
    os.makedirs(CARDS,exist_ok=True)
    for i,(t0,dur,lines,side,y0) in enumerate(specs):
        im=Image.new('RGBA',(W,H),(0,0,0,0)); d=ImageDraw.Draw(im); y=y0
        for txt,sz,bold in lines:
            f=ImageFont.truetype(BOLD if bold else REG,int(H*sz))
            tw=d.textlength(txt,font=f); x={'left':int(W*0.09),'right':int(W-tw-W*0.09),'mid':int((W-tw)/2)}[side]
            d.text((x+2,int(H*y)+2),txt,font=f,fill=(0,0,0,150)); d.text((x,int(H*y)),txt,font=f,fill=(255,255,255,255))
            y+=sz*1.35
        im.save(card_png(i),optimize=True)
    print('cards written to',CARDS); sys.exit(0)
PNG=not TEXT and all(os.path.exists(card_png(i)) for i in range(len(specs)))
inputs=[]
if TEXT: chain+=","+",".join(texts)+"[v]"
elif PNG:
    chain+="[v0]"
    for i,(t0,dur,lines,side,y0) in enumerate(specs):
        inputs+=['-loop','1','-framerate',R,'-t',str(dur),'-i',card_png(i)]
        chain+=(f";[{i}:v]format=rgba,fade=t=in:st=0:d=0.4:alpha=1,fade=t=out:st={dur-0.4}:d=0.4:alpha=1,setpts=PTS+{t0}/TB[c{i}]"
                f";[v{i}][c{i}]overlay=eof_action=pass:repeatlast=0[v{i+1}]")
    chain+=f";[v{len(specs)}]null[v]"
else: chain+="[v]"
# ---- sound: ambience + a tone per section; silent in the silent blacks (0.3 s ramps), untouched in the others
sil=[(a,b) for a,b,k,kind in blacks if kind=='silent']
gain="*".join(f"clip((abs(t-{(a+b)/2})-{(b-a)/2})/0.3\\,0\\,1)" for a,b in sil)
af=(f"anoisesrc=d={total}:c=pink:r=48000:a=0.06[n];sine=f=196:r=48000:d={total},tremolo=f=0.3:d=0.6,volume=0.12[s1];"
    f"sine=f=294:r=48000:d={total},tremolo=f=0.17:d=0.8,volume=0.08[s2];[n][s1][s2]amix=inputs=3:normalize=0,"
    f"volume='{gain}':eval=frame,aformat=channel_layouts=stereo[a]")
cmd=['ffmpeg','-y','-v','error']+inputs+['-filter_complex',";".join(fc)+";"+chain+";"+af,'-map','[v]','-map','[a]','-t',str(total),
     '-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-g','24','-c:a','aac','-b:a','160k','-movflags','+faststart',out]
json.dump({'total':total,'text':TEXT or PNG,'blacks':blacks,'cards':cards},open(out+'.json','w'),indent=1)
subprocess.run(cmd,check=True)
