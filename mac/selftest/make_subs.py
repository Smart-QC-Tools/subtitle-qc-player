import sys, os, random
out = sys.argv[1]
random.seed(1)
WORDS = "the harbour light keeper storm boat village night morning door rocks wind lamp ferry bakery cliff water rope bell tide".split()
def tc(fr, base_h=1):
    f = fr % 24; s = fr // 24
    return f"{base_h + s // 3600:02d}:{s // 60 % 60:02d}:{s % 60:02d}:{f:02d}"
def itt(n, seconds, lang, base_h=1):
    ps = []
    step = seconds * 24 // n
    for i in range(n):
        b = 24 + i * step
        e = b + max(12, step - random.choice([0, 0, 0, 1, 2, 6]))
        lines = [" ".join(random.choice(WORDS) for _ in range(random.randint(3, 8))).capitalize() for _ in range(random.choice([1, 2, 2, 3]))]
        ps.append(f'      <p begin="{tc(b, base_h)}" end="{tc(e, base_h)}">' + "<br/>".join(lines) + "</p>")
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" xmlns:tts="http://www.w3.org/ns/ttml#styling"
    xml:lang="{lang}" ttp:timeBase="smpte" ttp:frameRate="24" ttp:frameRateMultiplier="1000 1001" ttp:dropMode="nonDrop">
  <head><styling><style xml:id="s" tts:textAlign="center"/></styling>
    <layout><region xml:id="bottom" tts:origin="0% 0%" tts:extent="100% 100%" tts:displayAlign="after" tts:textAlign="center"/></layout></head>
  <body region="bottom" style="s"><div>
{chr(10).join(ps)}
  </div></body>
</tt>
'''
for code, secs, hour in (("T2001", 175, 1), ("T2002", 175, 0), ("T2003", 65, 1)):
    open(os.path.join(out, f"StressTest_S1_{code}_Hr0_2398_ENG_V1-R0.itt"), "w").write(itt(int(secs / 2.5), secs, "en-US", hour))
open(os.path.join(out, "StressTest_S1_T2001_Hr0_2398_GER_V1-R0.itt"), "w").write(itt(1500, 175, "de-DE", 1))
