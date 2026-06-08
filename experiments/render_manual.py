"""Render the HAND-CORRECTED plan (my cross-check of script+transcript), for the
user to approve. Each piece = (segment_id, verbatim phrase to keep from it).
  python -m experiments.render_manual
"""
from experiments.comp import render_pieces

# Cross-checked against script + full transcript. Phrases are trimmed verbatim
# substrings so locate() stops exactly where intended (e.g. seg10 without 'جو کہ',
# seg53 opening only — the fumbled 4-kanal body is dropped in favour of take B).
PIECES = [
    (1,  "تو اب ہم اپنی income کو دس گنا کر دیتے ہیں"),                       # 10x this income
    (10, "میں ہوں جاوید۔ میں نے چودہ کروڑ روپے invest کیے ایک tech startup کے اندر"),  # I'm Javed, invested
    (13, "جو بہت ہی زیادہ چلا اور اب میری net income ہے دس ہزار کروڑ روپے"),  # blew up, 10,000 cr
    (23, "وہی same trick کھیلوں گا loan لینے والی تاکہ کم سے کم ٹیکس دینا پڑے"),  # same loan trick
    # tax line = seg33's CLEAN second half (after the '--') + seg34, comped:
    {"seg": 33, "text": "یعنی اپنی total income پہ میں دو فیصد", "after_cutoff": True},  # "2% of my total income"
    (34, "ٹیکس دوں گا جو کہ بنے گا دو سو کروڑ روپے بنا ٹیکس کے"),             # "tax = 200cr tax-free"
    (40, "اور جو میرے دس ہزار کروڑ ہیں وہ دس percent کی growth سے بڑھتے جائیں"),  # grows at 10%
    (53, "اب چلتے ہیں میرے گھر کی طرف۔ میں F6 اسلام آباد میں رہتا ہوں"),       # to my house, F-6 (opening only)
    (57, "میرے بنگلے کی طرف۔ میرا بنگلہ چار کنال کے رقبے پر پھیلا ہوا ہے۔ اس کے اندر چھ"),  # clean take B body
    (58, "bedrooms ہیں totally بائیس کمرے ہیں"),                              # 6 bedrooms, 22 rooms
    (59, "اس کی total قیمت ڈھائی سو کروڑ روپے ہے"),                           # worth 250 cr
    (62, "اس میں ایک pool ہے، ایک private garden ہے، ایک basement entertainment complex ہے"),  # amenities
    (63, "میرے سات گھروں میں سے ایک ہے۔ میرے پاس ایک دبئی کے اندر ہے، ایک مدینہ کے اندر ہے"),  # seven homes (full)
]

if __name__ == "__main__":
    render_pieces(PIECES, "manual", "MANUAL (hand-corrected)")
