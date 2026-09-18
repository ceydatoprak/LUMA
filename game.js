/* ============================================================
   Hareket odaklı bir ruh geçiş oyunu.  (Oyunun yayınlandığı ad
   GAME.title içindedir, 1. bölümde — oradaki nota bakın.)
   ------------------------------------------------------------
   Oyuncu küçük bir ruh yaratığıdır. Yürüyemez. Yönlü sıçramalarla
   hareket eder: basılı tutarak gerilir, sürükleyerek nişan alır,
   bırakarak sıçrar. Yer çekimi onu yaylara doğru çeker, sıradan
   yüzeyler onu zıplatmak yerine tutar ve ilginç hareket havadayken
   yapabildikleriyle ortaya çıkar — bir duvara tutunmak, bir enerji
   düğümü tarafından yakalanıp yeniden yönlendirilmek ya da bir ruh
   yayı tarafından fırlatılmak.

   Bölümler
     1. Yapılandırma, ince ayar ve matematik
     2. Ses (Web Audio sentezi)
     3. Parçacıklar ve şok dalgaları
     4. Bölüm verisi
     5. Dünya oluşturma
     6. Çarpışma ve hareket
     7. Oyuncu (fizik / durum / görsel / girdi sözleşmesi)
     8. Oyun durum makinesi
     9. Çizim (rendering)
    10. Girdi
    11. Ana döngü
   ============================================================ */
(() => {
'use strict';

/* ============================================================
   1. YAPILANDIRMA, İNCE AYAR VE MATEMATİK
   ============================================================ */

/* ---- kimlik ----------------------------------------------------------------
   Oyunun adı SADECE burada yaşar, başka hiçbir yerde değil. Sayfa başlığı,
   başlık işareti, bitiş ekranı, erişilebilirlik etiketi ve sayfa meta verisi
   açılışta buradan yazılır; böylece oyunu yeniden adlandırmak, işaretlemenin
   bir köşesinde eski bir ad bırakmayan tek satırlık bir değişikliktir.

   `storageKey` bilerek başlıktan türetilmemiştir: kaydedilmiş ilerleme bir
   yeniden adlandırmadan sağ çıkmalıdır, bu yüzden oyuncunun tarayıcısının
   zaten tuttuğu anahtar aynı kalmalıdır. Bunu yalnızca herkesin ilerlemesini
   bilerek silmek istiyorsanız değiştirin. */
const GAME = {
  title:      'LUMA',
  lang:       'tr',
  storageKey: 'flux',
};

/* ---- oyuncuya görünen metin -----------------------------------------------
   Oyuncunun okuduğu her kelime, tek bir tabloda. Bölüm adları ve öğretici
   ipuçları kendi bölümleriyle birlikte yaşar, çünkü onlar bölüm içeriğidir;
   kabuğa ait olan her şey burada.

   Ton kısa ve sadedir. İlk kez oynayan biri bir ipucunu tek bakışta okuyup
   oyuna geri dönebilmelidir — mekanikler bölüm tarafından öğretilir, cümle
   yalnızca gördüklerini adlandırmak için vardır. */
const TEXT = {
  /* kabuk */
  tagline:      'Işığın yolunu bul.',
  controls:     'Basılı tut · geriye çek · bırak · R yeniden başlatır',
  description:  GAME.title + ' — küçük bir ruhu neon harabelerde yönlendir: ' +
                'geriye çek ve bırak, duvarlara tutun, ışık kürelerini kullan.',
  canvasLabel:  'oyun alanı',

  /* HUD */
  hudLevel:     'BÖLÜM',
  sound:        'Sesi aç veya kapat',
  restart:      'Bölümü yeniden başlat',

  /* durum */
  resume:       'KALDIĞIN BÖLÜMDEN DEVAM',

  /* tamamlama */
  endSub:       'YOLCULUK TAMAMLANDI',
  endTime:      'süre',
  endLevels:    'bölüm',
  replay:       'BAŞTAN OYNA',
};

const VW = 540, VH = 960;          // kamera viewport'u, dünya birimi cinsinden
const STEP = 1 / 60;               // sabit fizik adımı (saniye)

/* ---------------------------------------------------------------------------
   HAREKET İNCE AYARI
   ---------------------------------------------------------------------------
   Tek tablo, tek gerçek kaynak. Bunun dışında hiçbir yerde eşik uydurulmaz.

   Hızlar 1/60 saniyelik adım başına dünya birimidir; ivmeler adım başına
   birimin karesidir. Ölçek için: kamera 540 x 960 birim gösterir, ruh 13
   birim genişliğindedir ve tam güçte bir sıçrama ekranın çeyreğinden biraz
   fazlasını yükselir.

   Burada anlatılan his bir mermininki değil, bir yaratığınkidir. Sıradan
   yüzeylerin HİÇ geri sekmesi yoktur — normal bileşeni emerler ve ruhun
   kaymasının bir kısmını korumasına izin verirler; bütün dünyanın bir
   flipper masası gibi okunmasını önleyen de budur. Oyundaki her güçlü
   sekme kasıtlı bir nesnedir: bir yay seni fırlatır, bir düğüm seni yeniden
   yönlendirir. Enerji ekleyebilen tek iki şey bunlardır, bu yüzden hareket
   okunabilir kalır.
--------------------------------------------------------------------------- */
const MOVE = {
  /* --- gövde --------------------------------------------------------------- */
  radius:       13,

  /* --- yer çekimi ve hava --------------------------------------------------
     Düşük yer çekimi ve yayın tepesinde geniş bir süzülme bandı. Ruhun,
     okunmadan bitmek yerine, yayın gerçekleştiğini izleyip nereye gittiğini
     görebileceğiniz kadar uzun süre havada asılı kalması amaçlanmıştır. */
  gravity:      0.46,   // adım başına aşağı yönlü ivme
  floatBand:    4.4,    // bunun altındaki |vy| yayın tepesi sayılır
  floatScale:   0.48,   // oradaki yer çekimi çarpanı — uzun, okunabilir bir tepe
  fallMax:      14.0,   // uç (terminal) hız
  airDrag:      0.9975, // yalnızca yatay; dikey olan yer çekimi tarafından yönetilir

  /* --- sıçrama --------------------------------------------------------------
     Bu beş sayı beş ayrı düğme değil, tek bir tasarımdır.

     Yatay menzil, fırlatma hızının karesiyle artar; bu yüzden hız aralığı
     istediğimiz MENZİL aralığından seçilir, tersi değil: en düşük çekiş bile
     tam bir sıçramanın `reachMin` kadarını taşımalı, aradaki her şey
     kullanılabilir bir kadran gibi hissettirmelidir. reachMin 0.4 iken
     oyuncunun gerçekten hissedebildiği üç çekiş, tam menzilin kabaca
     %40 / %70 / %100'üne denk gelir.

     `dragFull` sanal ekran birimindedir — 540 genişliğindeki sanal kutunun
     250'si; böylece tam bir gerilme herhangi bir telefonda rahat bir baş
     parmak uzunluğunda bir kaydırmadır, kısa çekişler ise doğrudan maksimuma
     zıplamak yerine kontrol edilebilecek kadar mesafeye sahiptir. */
  burstMax:     16.8,   // tam taahhütlü sıçrama
  reachMin:     0.34,   // en düşük çekiş, tam bir sıçramanın bu kesrine ulaşır
  burstTime:    0.075,  // bırakıldıktan hemen sonraki yer çekimsiz an
  dragFull:     250,    // tam güç için sanal ekran biriminde gerilme
  dragDead:     14,     // bunun altında bırakma iptal sayılır, hiçbir şey harcanmaz

  /* --- sıradan yüzeyler: tutar, zıplatmaz ----------------------------------- */
  floorDot:     0.55,   // temas normali bundan daha dikeyse zemin sayılır
  landHard:     9.0,    // ağır bir iniş gibi okunan çarpma hızı
  slideKeep:    0.62,   // hızlı varışta korunan kayma
  groundDrag:   0.84,   // bir zemine yerleştikten sonra adım başına
  groundStop:   0.30,   // bunun altında ruh durdurulur
  ceilingKeep:  0.55,   // bir tavana sürtünmek biraz kayma maliyetine yol açar, başka bir şey değil
  wallSlide:    0.92,   // bir duvara sürtünmek, ALONG yönündeki hareketin neredeyse tamamını korur:
                        // 0.5 değerinde bir yüzeyde yukarı doğru sürtünme sıçramanın
                        // yarısına mal olurdu; bir duvarın üzerindeki çıkıntıya
                        // zıplamanın imkânsız hissettirmesinin başlıca nedeni buydu
  slop:         0.05,   // sessiz kalmak için bir temastan sonra korunan ayrılma

  /* --- iniş yardımı -----------------------------------------------------------
     Bir sıçramanın bir çıkıntının hemen kısasında düşmesi, en can sıkıcı
     başarısızlık biçimidir, çünkü oyuncu durumu doğru okumuştur. Güvenli bir
     yüzeyin tepesine yakın düşerken ruh ona doğru hafifçe itilir — oyuncunun
     zaten yaptığının çok altında, nazik bir ivme; böylece bu, bir anda
     ışınlanma değil, karakterin kenara uzanması gibi okunur. */
  assistReach:  46,     // itmenin kenarın ne kadar ötesinde hâlâ uygulandığı
  assistBand:   150,    // itmenin bir yüzey tepesinin ne kadar üstünde başladığı
  assistPull:   0.90,   // yardım sırasında adım başına yanal ivme
  assistMax:    5.0,    // itmenin ekleyebileceği en fazla yanal hız

  /* --- çıkıntı yardımı: aynı fikir, bir köşenin üzerine ÇIKARKEN için ------ */
  ledgeBand:    70,     // içe doğru sürüklenmenin uygulandığı üst kenara yakınlık
  ledgeReach:   40,     // yüzeyin ne kadar dışında hâlâ uygulandığı
  ledgePull:    0.85,   // bir köşeyi aşarken adım başına içe doğru ivme
  ledgeMax:     7.0,    // eklenebilecek en fazla içe doğru hız
  ledgeTime:    1.20,   // bir fırlatmanın köşe için ne kadar süre etkin kaldığı

  /* --- duvara tutunma ---------------------------------------------------------
     Bir duvar, bir refleks testi değil, durup düşünmek için güvenli bir
     yerdir. Temas tüm hızı yok eder, kavrama bir saniyeden fazla süreyle
     hiç kaymadan tutar ve ancak ondan sonra kaymaya başlar. */
  clingTime:    2.40,   // duvarın bırakmasından önceki toplam tutunma süresi
  clingGrip:    1.50,   // kayma başlamadan önceki tam kavrama süresi (saniye)
  clingSlide:   2.0,    // kavrama bittikten sonraki aşağı kayma hızı
  clingKick:    0.30,   // bir yüzey boyunca DÜZ bir fırlatma için dışa doğru itiş
  clingKickMin: 1.20,   // ...ve daha dik bir fırlatmanın aldığı çıplak ayrılma
  clingFree:    0.55,   // bunun üzerinde bir nişan yukarı yönlü sayılır, hatta
                        // duvara doğru işaret etse bile: bu, oyuncunun tuttuğu
                        // şeyin tepesinden geçmesi demektir
  wallRegrab:   0.16,   // duvarın seni bıraktıktan sonra yeniden yakalayamadığı süre (saniye)
  wallRegrabDist: 40,   // ...ya da yüzeyinden bu kadar uzaklaşana kadar

  /* --- hoşgörü ------------------------------------------------------------ */
  coyote:       0.13,   // bir yüzeyden ayrıldıktan hemen sonra nişan hâlâ çalışır
  /* Erken bir basış bir hata değil, niyettir. Ruh hâlâ havadayken basılı
     tutulan bir parmak, bir şey buna cevap verebildiği anda cevaplanır —
     zemin, bir duvar ya da bir düğüm — böylece tekrar gitmek istemek asla
     ikinci bir basışa mal olmaz. Cömerttir çünkü yalnızca oyuncunun hâlâ
     basılı tuttuğu bir basışı dönüştürür; bırakılan bir dokunuş sadece
     düşer. */
  buffer:       0.90,
  /* Takılı kalmış bir işaretçiye karşı bir koruma, oyuncunun asla
     karşılaşması gereken bir kural DEĞİL. Hareketsiz durmak oyuncunun
     bilinçli olması demektir ve bunu yaptığı sürece dünya donmuştur; bu
     yüzden tarayıcının bize hiç bildirmediği bir girdi dışında korunacak
     bir şey yoktur. */
  aimHold:      20.0,

  /* --- enerji düğümleri ------------------------------------------------------ */
  nodeReach:    130,    // cömert yakalama yarıçapı — bu mobilde bir hedef
  nodePull:     0.30,   // düğümün ruhu kendine doğru çektiği kare başına miktar
  nodeBurst:    17.4,   // tam güçte bırakma hızı
  nodeReachMin: 0.52,   // bir düğüm her zaman fırlatır, bu yüzden alt sınırı daha yüksektir
  nodeCool:     2.40,   // harcanmış bir düğümün yeniden kullanılabilmesi için geçmesi gereken saniye

  /* --- ruh yayları ------------------------------------------------------------
     Bir yay, bedavaya enerji dağıtan tek nesnedir; bu yüzden onun SONSUZ
     miktarda dağıtmasını engelleyen kurallar da burada yaşar.

     Bir fiziksel temas tam olarak bir fırlatma üretmelidir. Yay, az önce
     fırlattığı bedene kilitlenir ve o beden etkinleştirme bölgesinden açıkça
     çıkana kadar sönük kalır — `springExit`, "açıkça" ile kastedilen budur
     ve asıl kural budur. `springCool` yalnızca bir bedenin birkaç kare
     içinde dışarı fırlatılıp geri geldiği durum için ikinci bir savunma
     hattıdır; `springClear` ise fırlatmanın kendisinin bıraktığı ayrılıktır,
     böylece bir sonraki alt adım aynı çakışmayı bulamaz. */
  springSpeed:  19.5,   // yayın yüzeyi boyunca fırlatma hızı
  springKeep:   0.18,   // fırlatma boyunca korunan yanal hareket
  springClear:  8,      // fırlatmada yüzeyin ötesinde bırakılan boşluk, birim cinsinden
  springExit:   34,     // tetikleyicinin ne kadar dışında yayın yeniden kurulduğu
  springCool:   0.30,   // ikincil koruma: iki fırlatma arasındaki en az saniye
  /* Öngöremediğimiz geometri için bir yedek önlem. Oyuncunun hiç söz sahibi
     olmadığı, AYNI yay tarafından yapılan fırlatmalar sayılır ve bir fazlası,
     kontrol geri gelene kadar o yayı devre dışı bırakır — belirli bir saniye
     sayısı için değil, çünkü bu asla doğru olamaz: ruhun havada ne kadar
     kalacağına fırlatmanın kendisi karar verir. Sayaç, oyuncu tekrar hareket
     edebildiği anda sıfırlanır; böylece bir yaydan bilerek sekip duran biri
     bunu asla tetiklemez. */
  springLoopMax: 2,     // devre dışı bırakmadan önce bir yayın kesintisiz fırlatma sayısı

  /* --- kamera -------------------------------------------------------------------
     Görünüm takip etmez, öne geçer. Nişan alınırken sıçramanın işaret
     ettiği yöne doğru kayar ve yavaşlayarak durur; böylece oyuncu karar
     vermeden önce hedef ekrandadır — oyundaki en büyük adalet sorunu,
     görülemeyen yerlere sıçrama istemekti. */
  camLead:      360,    // tam güçte bir gerilmenin görünümü ne kadar öne aldığı
  camLeadMin:   110,    // ...ve en küçüğünün ne kadar aldığı
  camFollow:    7.5,    // hareket hızı birimi başına görünüm kayması
  camEase:      0.10,   // seyahat ederken ve yerleşirken
  camEaseAim:   0.13,   // bir gerilme tutulurken
  camEaseRest:  0.07,   // hareketsiz durulurken: en yavaşı, hiçbir şey seğirmesin diye
  camSettle:    0.55,   // varıştan sonraki yumuşak dönüşün saniyesi
  camTravelSpeed: 2.0,  // bunun üzerinde görünüm ruhu seyahat ediyor sayar
  zoomAim:      0.80,   // tam bir gerilme için görünümün en fazla uzaklaştığı nokta
  zoomFast:     0.93,   // en yüksek seyahat hızındaki görünüm ölçeği
  zoomEase:     0.06,   // yakınlaştırma için TEK bir yumuşatma oranı, tek bir yerde uygulanır
  camHold:      0.66,   // ruh yarı görünümün bu kadarından daha uzakta asla
                        // durmaz: kareler içinde, arka tarafa yakın kalır

  /* --- sınırlar ve başarısızlık ----------------------------------------------- */
  speedMax:     34,     // yalnızca kararlılık için sert sınır
  hurtTime:     0.30,   // yeniden doğumdan önceki çözülme süresi (saniye)
  respawnTime:  0.22,   // kontrolün geri gelmesinden önceki yeniden şekillenme süresi (saniye)
};

/* ---- gerilmenin hissi -----------------------------------------------------
   İki eğri, iki farklı iş yapıyor.

   `powerCurve`, lastiğin ne kadar gerildiğini oyuncunun istediği güç
   miktarına çevirir. Bu bir smoothstep'tir ve çekişe direncini veren de
   budur: gerilmenin ilk kısmı gücü yavaş hareket ettirir, böylece küçük
   düzeltmeler kolayca yapılabilir; orta kısım aralığın çoğunun yaşadığı
   yerdir; son kısım ise düzleşir, böylece maksimum düşülen bir kenar değil,
   yaslanılan bir sınır gibi hissettirir.

   `burstSpeed`, o gücü bir fırlatma hızına çevirir. Menzil hızın karesiyle
   arttığı için burada karekök almak, kadranın mesafede doğrusal okunmasını
   sağlar — güç 0.5 gerçekten de en kısa ve en uzun sıçrama arasında kabaca
   yarı yola iner, uzak uca yakın bir yere değil. */
const smoothstep = (t) => t * t * (3 - 2 * t);
const powerCurve = smoothstep;
const burstSpeed = (p) =>
  MOVE.burstMax * Math.sqrt(MOVE.reachMin + (1 - MOVE.reachMin) * clamp(p, 0, 1));

/* Bir gücün hıza dönüştüğü tek yer; zemin, duvar ya da düğüm için geçerlidir. */
const launchSpeed = (p, fromNode) => fromNode
  ? MOVE.nodeBurst * Math.sqrt(MOVE.nodeReachMin + (1 - MOVE.nodeReachMin) * clamp(p, 0, 1))
  : burstSpeed(p);

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeIn = (t) => t * t * t;
const easeInOut = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clone = (o) => JSON.parse(JSON.stringify(o));

/* ---- renk paleti ----------------------------------------------------------
   Neon kimlik korunuyor, ama artık renk yalnızca atmosfer: sana bir şeyin
   NE OLDUĞUNU söyler, asla neyi kabul edeceğini değil. */
const HUE = {
  spirit: { rgb: [150, 226, 255], hi: [240, 252, 255] },   // oyuncu
  node:   { rgb: [255, 196, 108], hi: [255, 240, 208] },   // enerji düğümü
  spring: { rgb: [126, 255, 186], hi: [226, 255, 240] },   // ruh yayı
  mote:   { rgb: [198, 160, 255], hi: [240, 228, 255] },   // kontrol noktası
  gate:   { rgb: [140, 230, 255], hi: [236, 252, 255] },   // bölüm çıkışı
  stone:  { rgb: [122, 150, 208], hi: [196, 220, 255] },   // sıradan yüzey
};
const DANGER = [255, 66, 116];
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

function roundRect(c, x, y, w, h, r) {
  r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y); c.arcTo(x + w, y, x + w, y + r, r);
  c.lineTo(x + w, y + h - r); c.arcTo(x + w, y + h, x + w - r, y + h, r);
  c.lineTo(x + r, y + h); c.arcTo(x, y + h, x, y + h - r, r);
  c.lineTo(x, y + r); c.arcTo(x, y, x + r, y, r);
  c.closePath();
}

/* ---- uyarlanabilir kalite --------------------------------------------------
   Yalnızca süsleme ölçeklenir. Fizik, çarpışma ve girdi hiç değişmez; bu
   yüzden oyun yavaş bir telefonda ve hızlı bir masaüstünde aynı şekilde
   oynanır. */
const Q = { level: 1, avg: 16.7, work: 0, bad: 0, good: 0, particleScale: 1 };

// aygıt pikseli cinsinden arka bellek bütçesi (bkz. fit())
const PIXEL_BUDGET = 1100000;
const PIXEL_BUDGET_LOW = 700000;

function grad(store, key, make) {
  let g = store[key];
  if (g === undefined) g = store[key] = make();
  return g;
}

/* ============================================================
   2. SES — ilk etkileşimde kilidi açılan küçük bir sentez kiti
   ============================================================ */

const Sfx = (() => {
  /* --------------------------------------------------------------------
     Yumuşak, fütüristik bir palet. Her şey ortak bir alçak geçiren filtre
     ve kısa bir ambiyans gönderimi üzerinden sinüs / üçgen / filtrelenmiş
     gürültüdür; böylece hiçbir şey bir arcade bipine dönüşemez. Düğümler
     ses başına oluşturulur (ucuzdurlar ve kendilerini kendileri temizler)
     ama gürültü arabelleği, filtreler, kompresör ve gecikme ağı yalnızca
     bir kez kurulur.
     -------------------------------------------------------------------- */
  const MIX = {
    master: 0.42,
    burst:  0.5,
    spring: 0.5,
    node:   0.44,
    land:   0.3,
    cling:  0.34,
    mote:   0.4,
    gate:   0.5,
    fail:   0.36,
    ui:     0.22,
    sweep:  0.3,
  };

  let ctx = null, master = null, bus = null, air = null, noiseBuf = null;
  let on = true, ready = false, tension = null;
  let ambience = null, windGain = null;
  let voices = 0;
  let lastLand = -1;

  function build() {
    if (ctx || !on) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { on = false; return null; }
    try { ctx = new AC(); } catch (e) { on = false; return null; }

    master = ctx.createGain();
    master.gain.value = MIX.master;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -22; comp.knee.value = 26; comp.ratio.value = 6;
    comp.attack.value = 0.006; comp.release.value = 0.25;

    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 7200;
    tone.Q.value = 0.4;

    bus = ctx.createGain();
    bus.connect(tone); tone.connect(comp); comp.connect(master);
    master.connect(ctx.destination);

    air = ctx.createGain();
    air.gain.value = 0.3;
    const d1 = ctx.createDelay(0.5), d2 = ctx.createDelay(0.5);
    d1.delayTime.value = 0.085; d2.delayTime.value = 0.147;
    const fb = ctx.createGain(); fb.gain.value = 0.26;
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass'; damp.frequency.value = 2600;
    air.connect(d1); d1.connect(d2); d2.connect(damp); damp.connect(fb);
    fb.connect(d1); damp.connect(bus);

    const n = Math.floor(ctx.sampleRate * 0.8);
    noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;

    ambience = ctx.createGain(); ambience.gain.value=.012; ambience.connect(bus);
    for (const hz of [130.81,196.0]) { const o=ctx.createOscillator(); o.frequency.value=hz; o.connect(ambience); o.start(); }
    const breeze=ctx.createBufferSource(); breeze.buffer=noiseBuf; breeze.loop=true;
    const filter=ctx.createBiquadFilter(); filter.type='lowpass'; filter.frequency.value=550;
    windGain=ctx.createGain(); windGain.gain.value=0;
    breeze.connect(filter); filter.connect(windGain); windGain.connect(bus); breeze.start();
    ready = true;
    return ctx;
  }

  function unlock() {
    build();
    if (ctx && ctx.state !== 'running') ctx.resume();
  }

  function out(node, send) {
    node.connect(bus);
    if (send) { const g = ctx.createGain(); g.gain.value = send; node.connect(g); g.connect(air); }
  }
  function done() { voices--; }

  function tone(o) {
    if (!ready || !on || voices > 14) return;
    const t = ctx.currentTime + (o.delay || 0);
    const dur = o.dur || 0.3;
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f0, t);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + (o.glide || dur));
    if (o.detune) osc.detune.value = o.detune;

    const g = ctx.createGain();
    const peak = Math.max(0.0004, o.peak || 0.1);
    const atk = o.attack || 0.014;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + atk);
    g.gain.exponentialRampToValueAtTime(peak * 0.28, t + atk + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    let node = osc;
    if (o.lp) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(o.lp, t);
      if (o.lp1) f.frequency.exponentialRampToValueAtTime(Math.max(60, o.lp1), t + dur);
      f.Q.value = o.q || 0.7;
      node.connect(f); node = f;
    }
    node.connect(g);
    out(g, o.send);
    voices++;
    osc.onended = done;
    osc.start(t); osc.stop(t + dur + 0.06);
  }

  function air_noise(o) {
    if (!ready || !on || voices > 14) return;
    const t = ctx.currentTime + (o.delay || 0);
    const dur = o.dur || 0.25;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.playbackRate.value = o.rate || 1;

    const f = ctx.createBiquadFilter();
    f.type = o.type || 'bandpass';
    f.frequency.setValueAtTime(o.f0 || 900, t);
    if (o.f1) f.frequency.exponentialRampToValueAtTime(Math.max(80, o.f1), t + dur);
    f.Q.value = o.q || 0.9;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = o.cap || 5200;

    const g = ctx.createGain();
    const peak = Math.max(0.0004, o.peak || 0.05);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + (o.attack || 0.012));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    src.connect(f); f.connect(lp); lp.connect(g);
    out(g, o.send);
    voices++;
    src.onended = done;
    src.start(t); src.stop(t + dur + 0.05);
  }

  /* --- sürekli gerilme gerilimi: tek ses, tutulan, hafifçe filtrelenmiş --- */
  function tensionStart() {
    if (!ready || !on || tension) return;
    const osc = ctx.createOscillator(); osc.type = 'sine';
    const osc2 = ctx.createOscillator(); osc2.type = 'triangle';
    osc2.detune.value = 7;
    const g = ctx.createGain(); g.gain.value = 0.0001;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 700; f.Q.value = 3;
    osc.frequency.value = 96; osc2.frequency.value = 144;
    osc.connect(f); osc2.connect(f); f.connect(g); g.connect(bus);
    osc.start(); osc2.start();
    tension = { osc, osc2, g, f };
  }
  function tensionUpdate(p) {
    if (!tension) return;
    const t = ctx.currentTime;
    tension.osc.frequency.setTargetAtTime(78 + p * 150, t, 0.06);
    tension.osc2.frequency.setTargetAtTime(118 + p * 232, t, 0.06);
    tension.f.frequency.setTargetAtTime(420 + p * 1100, t, 0.07);
    tension.g.gain.setTargetAtTime(0.004 + p * 0.026, t, 0.06);
  }
  function tensionStop() {
    if (!tension) return;
    const t = ctx.currentTime;
    const { osc, osc2, g } = tension;
    g.gain.setTargetAtTime(0.0001, t, 0.04);
    osc.stop(t + 0.25); osc2.stop(t + 0.25);
    tension = null;
  }

  return {
    unlock, tensionStart, tensionUpdate, tensionStop,
    environment(near) { if(windGain) windGain.gain.setTargetAtTime(near?.018:0,ctx.currentTime,.3); },
    suspend(hidden) { if(ctx) { if(hidden) ctx.suspend(); else if(on) ctx.resume(); } },
    crack() { air_noise({dur:.22,peak:.065,f0:1800,f1:650,q:2,cap:2800}); tone({f0:740*rand(.98,1.02),f1:370,dur:.16,peak:.022}); },
    setMuted(v) { on = !v; if (master) master.gain.value = v ? 0 : MIX.master; },

    /* ruhun kendini fırlatması: alçak bir nabız ve yükselen bir nefes */
    burst(p) {
      const v = MIX.burst;
      tone({ type: 'sine', f0: 92 + p * 36, f1: 188 + p * 96, dur: 0.3, glide: 0.13,
             peak: 0.2 * v, attack: 0.008, lp: 1400, lp1: 620, send: 0.12 });
      tone({ type: 'triangle', f0: 244 + p * 126, f1: 442 + p * 220, dur: 0.24, glide: 0.11,
             peak: 0.085 * v, attack: 0.012, lp: 2400, send: 0.16 });
      air_noise({ dur: 0.2, peak: 0.05 * v, f0: 620, f1: 2100 + p * 900, q: 0.7, cap: 4200, send: 0.2 });
    },

    /* bir yüzeyle buluşmak: yumuşak, ahşabımsı bir yerleşme — asla bir tık değil */
    land(hard) {
      const s = clamp(hard, 0, 1);
      const now = ready ? ctx.currentTime : 0;
      if (now - lastLand < 0.05) return;
      lastLand = now;
      const m = MIX.land * (0.4 + s * 0.6) * rand(.94,1.06);
      tone({ type: 'sine', f0: (132 - s * 28) * rand(.97,1.03), f1: 82, dur: 0.14, glide: 0.1,
             peak: 0.5 * m, attack: 0.005, lp: 760 });
      air_noise({ dur: 0.07, peak: 0.24 * m, f0: 520 + s * 500, f1: 260, q: 1.3, cap: 2600 });
    },

    /* bir duvara tutunmak: kısa bir nefes, neredeyse bir soluk kesilmesi */
    cling() {
      const v = MIX.cling * rand(.94,1.06);
      air_noise({ dur: 0.14, peak: 0.22 * v, f0: 1700, f1: 700, q: 1.1, cap: 4200, send: 0.2 });
      tone({ type: 'sine', f0: 320 * rand(.97,1.03), f1: 250, dur: 0.14, glide: 0.1, peak: 0.2 * v, attack: 0.008, lp: 1800 });
    },

    /* bir enerji düğümünün tutması: nişanın altında oturan sıcak bir çan */
    nodeCatch() {
      const v = MIX.node;
      [523.3, 784].forEach((f, i) => {
        tone({ type: 'sine', f0: f * 0.94, f1: f, dur: 0.5 - i * 0.12, glide: 0.12,
               peak: (0.2 - i * 0.06) * v, attack: 0.008, delay: i * 0.02, lp: 4600, send: 0.4 });
      });
      air_noise({ dur: 0.3, peak: 0.06 * v, f0: 1600, f1: 4200, q: 0.8, cap: 5600, attack: 0.04, send: 0.4 });
    },

    /* bir düğümün yükünü bırakması */
    nodeFire(p) {
      const v = MIX.node;
      tone({ type: 'triangle', f0: 392, f1: 880 + p * 300, dur: 0.3, glide: 0.14,
             peak: 0.18 * v, attack: 0.006, lp: 3600, send: 0.3 });
      tone({ type: 'sine', f0: 110, f1: 210, dur: 0.24, glide: 0.1, peak: 0.24 * v, attack: 0.006, lp: 1000 });
      air_noise({ dur: 0.22, peak: 0.07 * v, f0: 900, f1: 3400, q: 0.7, cap: 5000, send: 0.3 });
    },

    /* bir yayın ruhu fırlatması: bas ağırlıklı, cömert, yukarı doğru bir kuyrukla */
    spring() {
      const v = MIX.spring;
      tone({ type: 'sine', f0: 72, f1: 146, dur: 0.3, glide: 0.11,
             peak: 0.36 * v, attack: 0.006, lp: 900, send: 0.12 });
      tone({ type: 'triangle', f0: 294, f1: 660, dur: 0.26, glide: 0.14,
             peak: 0.12 * v, attack: 0.012, lp: 2800, send: 0.24 });
      air_noise({ dur: 0.1, peak: 0.07 * v, f0: 1500, f1: 800, q: 1.1, cap: 4200 });
    },

    /* bir kontrol noktasını almak: küçük, berrak bir çıngırak */
    mote() {
      const v = MIX.mote;
      [659.3, 987.8].forEach((f, i) => {
        tone({ type: 'sine', f0: f, dur: 0.6 - i * 0.16, peak: (0.17 - i * 0.05) * v,
               attack: 0.006 + i * 0.004, delay: i * 0.05, lp: 5200, send: 0.45 });
      });
      air_noise({ dur: 0.3, peak: 0.1 * v, f0: 2600, f1: 1000, q: 1.1, cap: 6000, send: 0.4 });
    },

    /* geçit: yukarı doğru açılan yumuşak bir akor, havadar bir kuyruk, gösterişsiz */
    gate() {
      const v = MIX.gate;
      [261.6, 392, 523.3, 659.3].forEach((f, i) => {
        tone({ type: 'sine', f0: f * 0.94, f1: f, dur: 1.0 - i * 0.1, glide: 0.3,
               peak: (0.17 - i * 0.03) * v, attack: 0.03 + i * 0.01,
               delay: i * 0.05, lp: 4600, send: 0.45 });
      });
      tone({ type: 'triangle', f0: 784, f1: 1046, dur: 0.6, glide: 0.35,
             peak: 0.045 * v, attack: 0.06, delay: 0.1, lp: 5400, send: 0.5 });
      air_noise({ dur: 0.7, peak: 0.05 * v, f0: 900, f1: 4200, q: 0.6, cap: 5600,
                  attack: 0.12, send: 0.5 });
    },

    /* parçalanma — yumuşak ve kısa, çünkü yeniden deneme anında olur */
    fail() {
      const v = MIX.fail;
      tone({ type: 'sine', f0: 210, f1: 62, dur: 0.4, glide: 0.3,
             peak: 0.3 * v, attack: 0.008, lp: 1500, lp1: 220, send: 0.2 });
      tone({ type: 'triangle', f0: 314, f1: 96, dur: 0.3, glide: 0.22,
             peak: 0.1 * v, attack: 0.012, lp: 1200, send: 0.25 });
      air_noise({ dur: 0.32, peak: 0.07 * v, f0: 1700, f1: 240, q: 0.7, cap: 3400, send: 0.3 });
    },

    /* son kontrol noktasında yeniden şekillenme */
    respawn() {
      const v = MIX.mote;
      tone({ type: 'sine', f0: 196, f1: 392, dur: 0.34, glide: 0.2,
             peak: 0.2 * v, attack: 0.01, lp: 3000, send: 0.3 });
      air_noise({ dur: 0.26, peak: 0.06 * v, f0: 500, f1: 2600, q: 0.7, cap: 4600, attack: 0.05, send: 0.3 });
    },

    /* bir ret: donuk, kibar bir gümbürtü */
    deny() {
      tone({ type: 'sine', f0: 190, f1: 140, dur: 0.16, glide: 0.1,
             peak: 0.1, attack: 0.006, lp: 700 });
      air_noise({ dur: 0.1, peak: 0.02, f0: 460, f1: 240, q: 1.4, cap: 2200 });
    },

    ui() {
      tone({ type: 'sine', f0: 660, f1: 520, dur: 0.075, glide: 0.06,
             peak: 0.34 * MIX.ui, attack: 0.006, lp: 2600, send: 0.16 });
    },

    sweep() {
      const v = MIX.sweep;
      air_noise({ dur: 0.5, peak: 0.07 * v, f0: 300, f1: 2600, q: 0.5, cap: 4200,
                  attack: 0.14, send: 0.35 });
      tone({ type: 'sine', f0: 110, f1: 240, dur: 0.44, glide: 0.34,
             peak: 0.16 * v, attack: 0.06, lp: 1200, send: 0.2 });
    },

    complete() {
      const v = MIX.gate;
      [261.6, 329.6, 392, 523.3].forEach((f, i) => {
        tone({ type: 'sine', f0: f, dur: 1.5, peak: 0.13 * v,
               attack: 0.12 + i * 0.03, delay: i * 0.08, lp: 4000, send: 0.5 });
      });
    },
  };
})();

/* ============================================================
   3. PARÇACIKLAR VE ŞOK DALGALARI  (sabit havuzlar, sıfır bellek ayırma)
   ============================================================ */

const PMAX = 72;
const parts = new Array(PMAX);
for (let i = 0; i < PMAX; i++) {
  parts[i] = { on: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 2,
               col: HUE.spirit.rgb, drag: 0.94, shape: 0, ang: 0, spin: 0, len: 0,
               grow: 0, grav: 0 };
}
let pCursor = 0;
function newPart() {
  for (let i = 0; i < PMAX; i++) {
    const p = parts[(pCursor + i) % PMAX];
    if (!p.on) { pCursor = (pCursor + i + 1) % PMAX; return p; }
  }
  const p = parts[pCursor]; pCursor = (pCursor + 1) % PMAX; return p;
}

const RMAX = 12;
const rings = new Array(RMAX);
for (let i = 0; i < RMAX; i++) {
  rings[i] = { on: false, x: 0, y: 0, r0: 0, r1: 0, life: 0, max: 1, col: HUE.spirit.rgb, w: 3 };
}
let rCursor = 0;
function newRing() {
  for (let i = 0; i < RMAX; i++) {
    const r = rings[(rCursor + i) % RMAX];
    if (!r.on) { rCursor = (rCursor + i + 1) % RMAX; return r; }
  }
  const r = rings[rCursor]; rCursor = (rCursor + 1) % RMAX; return r;
}

const FX = {
  shock(x, y, r0, r1, dur, col, w) {
    const r = newRing();
    r.on = true; r.x = x; r.y = y; r.r0 = r0; r.r1 = r1; r.life = dur; r.max = dur;
    r.col = col; r.w = w || 3;
  },
  spark(x, y, ang, spread, speed, count, col, opt) {
    opt = opt || {};
    count = Math.max(1, Math.round(count * Q.particleScale));
    for (let i = 0; i < count; i++) {
      const p = newPart();
      const a = ang + rand(-spread, spread);
      const sp = speed * rand(0.35, 1);
      p.on = true; p.x = x + rand(-2, 2); p.y = y + rand(-2, 2);
      p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp;
      p.max = p.life = (opt.life || 0.5) * rand(0.6, 1.2);
      p.size = (opt.size || 2.4) * rand(0.6, 1.3);
      p.col = col; p.drag = opt.drag || 0.93;
      p.shape = opt.shape || 0;     // 0 nokta, 1 çizgi, 2 halka-nokta
      p.ang = a; p.spin = rand(-0.2, 0.2); p.len = opt.len || 10;
      p.grow = opt.grow || 0;
      p.grav = opt.grav || 0;
    }
  },
  implode(x, y, r, count, col, life) {
    count = Math.max(3, Math.round(count * Q.particleScale));
    for (let i = 0; i < count; i++) {
      const a = rand(0, TAU);
      const p = newPart();
      const d = r * rand(0.6, 1.25);
      p.on = true;
      p.x = x + Math.cos(a) * d; p.y = y + Math.sin(a) * d;
      const sp = d / (life * 60) * rand(0.9, 1.1);
      p.vx = -Math.cos(a) * sp; p.vy = -Math.sin(a) * sp;
      p.max = p.life = life * rand(0.8, 1);
      p.size = rand(1.4, 3.2); p.col = col; p.drag = 1.0; p.shape = 0;
      p.grow = -0.4; p.grav = 0;
    }
  },
};

function updateParticles() {
  for (let i = 0; i < PMAX; i++) {
    const p = parts[i];
    if (!p.on) continue;
    p.life -= STEP;
    if (p.life <= 0) { p.on = false; continue; }
    p.x += p.vx; p.y += p.vy;
    p.vx *= p.drag; p.vy *= p.drag;
    if (p.grav) p.vy += p.grav;
    p.ang += p.spin;
    if (p.grow) p.size = Math.max(0.2, p.size * (1 + p.grow * STEP));
  }
  for (let i = 0; i < RMAX; i++) {
    const r = rings[i];
    if (!r.on) continue;
    r.life -= STEP;
    if (r.life <= 0) r.on = false;
  }
}

function clearFX() {
  for (let i = 0; i < PMAX; i++) parts[i].on = false;
  for (let i = 0; i < RMAX; i++) rings[i].on = false;
}

/* ---- ortam parçacıkları: kamera uzayında çizilir, bu yüzden hiç ayıklama gerekmez ---- */
const DUST = [];
for (let i = 0; i < 30; i++) {
  DUST.push({ x: rand(0, VW), y: rand(0, VH), z: rand(0.25, 1),
              vx: rand(-0.09, 0.09), vy: rand(-0.16, -0.03), s: rand(0.6, 2.0), t: rand(0, TAU) });
}
let dustPhase = 0;
function updateDust() {
  if ((dustPhase ^= 1)) return;          // süslemedir: 30 Hz fazlasıyla yeterli
  for (const d of DUST) {
    d.x += d.vx * d.z; d.y += d.vy * d.z; d.t += 0.04 * d.z;
    if (d.y < -8) { d.y = VH + 8; d.x = rand(0, VW); }
    if (d.x < -8) d.x = VW + 8; else if (d.x > VW + 8) d.x = -8;
  }
}

/* ============================================================
   4. BÖLÜM VERİSİ
   ============================================================
   Her şey veridir. Bir bölüm, bir dünya kutusu artı varlık listeleridir; yeni
   bir tür eklemek, ENTITY_KINDS içinde tek bir girdi ve tek bir çizim
   fonksiyonu demektir, simülasyonda asla bir dallanma değil.

   Varlık türleri
     solid   güvenli yüzey. Ruhu tutar: üzerine iner, kayar ya da tutunur.
     spring  ruh yayı. Ruhu kendi yüzeyi boyunca fırlatır. Dünyada bedavaya
             enerji dağıtan tek şey.
     node    enerji düğümü. Havadaki bir ruhu yakalar, böylece yeniden
             yönlendirilebilir; sonra şarj olurken kararır.
     mote    kontrol noktası. Dokunulduğunda alınır, yeniden doğma noktası
             olur.
     spike   sabit, öldürücü çıkıntı.
     beam    öldürücü enerji ışını; `pulse` onu bir döngüde yanıp söndürür.
     gap     boşluk. İçine düşmek ya da dünyanın dışına çıkmak ruhu eritir.

   `name` ve `tip`, buradaki tek oyuncuya görünen metinlerdir ve kabuk metni
   değil, bölüm içeriği oldukları için bölümle birlikte yaşarlar. Bir ipucu
   varışta bir kez gösterilir ve yalnızca bölümün konusu olan TEK şeyi
   adlandırır — bunu öğreten, bölümün kendisidir.

   Herhangi bir varlık, salınmak ya da süpürmek için `motion` taşıyabilir.
   ============================================================ */

/* ---- yazım yardımcıları ----------------------------------------------------
   Bir tasarımcı bir yüzeyi "şu kenarlar, şu üst" olarak düşünür. Simülasyon
   ise bir merkez ve bir boyut ister. Bu iki satır tüm çeviridir ve
   aşağıda yazılan her sayının, yukarıdaki ölçümlere göre doğrudan akıl
   yürütülebilecek bir sayı olması için vardır.

   `at`, bir yüzeyde durmak için rota konum noktasını döndürür: ruhun
   dinlenme merkezi, üstün bir yarıçap yukarısıdır. */
const ledge = (l, r, top, h, extra) =>
  Object.assign({ x: (l + r) / 2, y: top + h / 2, w: r - l, h }, extra || {});
const tower = (l, r, top, bottom, extra) =>
  Object.assign({ x: (l + r) / 2, y: (top + bottom) / 2, w: r - l, h: bottom - top }, extra || {});
const topOf = (s) => s.y - s.h / 2;
const at = (s, x) => [x === undefined ? s.x : x, topOf(s) - MOVE.radius, 'ground'];
/* Bir kulenin bir yüzüne tutunma: `side`, sol yüzü için -1, sağ yüzü için
   +1'dir; ruh ondan bir yarıçap uzakta oturur. */
const grip = (s, side, y) => [s.x + side * (s.w / 2 + MOVE.radius), y, 'cling'];
const via = (n) => [n.x, n.y, 'node'];
const onto = (sp) => [sp.x, sp.y, 'spring'];
/* Geçit, taçlandırdığı yüzeyin biraz üstünde süzülür; bu yüzeye varmak,
   yeterince yakın olduğu için geçide varmak demektir. Hedef bir yerdir,
   son bir uğraştırıcı girdi değil. */
const gateOn = (s, x) => ({ x: x === undefined ? s.x : x, y: topOf(s) - 55 });
/* Bir kontrol noktası, platformunun hemen üstünde oturur; böylece yeniden
   doğma, ruhu herhangi bir şeyin içine değil, son birkaç birim içinde sağlam
   zemine bırakır. */
const checkOn = (s, x) => ({ x: x === undefined ? s.x : x, y: topOf(s) - 42 });

/* ---------------------------------------------------------------------------
   KAMPANYA

   On beş bölüm, her seferinde bir yeni fikir; tahmin edilen değil, ölçülmüş
   sayılara göre inşa edildi. `node tests/measure-reach.cjs` ve
   `node tests/measure-camera.cjs`, aşağıdaki geometrinin boyutlandırıldığı
   iki tabloyu yazdırır; `node tests/validate-levels.cjs` ise her bölümü
   bunlara göre denetler. Kısa özeti:

     tam güçte bir sıçrama düz 917 birim taşır ya da dikine 405 yükselir
     +160 yükseklikte, yatayda 733 birim kalır
     bir enerji düğümü biraz daha sert fırlatır: düz 961, yukarı 427
     bir duvar tutunuşu, zeminle tamamen aynı sertlikte fırlatır
     12 derecede bir yay 526 yükselir ve inişte 365 birim yatay taşır;
       20 derecede 486 ve 573; 28 derecede 438 ve 732

   ...ve geometriyi asıl belirleyen sayı:

     NİŞAN ALIRKEN OYUNCU YAKLAŞIK 560 BİRİM İLERİYİ VE 990 BİRİM YUKARIYI GÖREBİLİR.

   Görünüm 540 x 960 ve dikeydir. Bu yüzden yatay bir sıçrama fiziksel olarak
   mümkün olsa bile kör bir atlayış olabilir; zorunlu bir yana sıçramadaki
   dürüst sınır 917 değil, yaklaşık 500 birimdir. Bu tek gerçek, kampanyanın
   sağa doğru koşmak yerine tırmanması, katlanması ve zikzak yapmasının
   nedenidir: yüksekliği kadraja almak ucuzdur, mesafeyi değil. Uzun
   sıçramalar, karşı tarafın görülmemesinin oyuncunun kendi seçimi olduğu
   isteğe bağlı kısayollara bırakılmıştır.

   Zorluk, bir sıçramanın istediği şeyle artar — zamanlama, sıralama, bir
   rota seçmek, bir düzeni okumak — ve yalnızca nadiren onu uzatarak.
--------------------------------------------------------------------------- */

const LEVELS = [];

/* === 1. İlk temas =========================================================
   Tek bir şeyi öğret: daha çok geriye çek, daha ileri git. Sağa doğru
   tırmanan üç geniş çıkıntı, hiçbir şeyin ters gitmemesi için tüm dünyayı
   kaplayan bir zemin ve hiçbir mekanik yok. Ortadaki sıçrama uzun olandır;
   bu yüzden bölüm "kolay, kolay, kolay" yerine "kısa, daha uzun, kısa" der.
   Hedef: 1/10. */
LEVELS.push((() => {
  const floor = ledge(0, 1660, 950, 150);
  const p1 = ledge(-20, 380, 815, 120);
  const p2 = ledge(500, 780, 690, 90);      // boşluk 120, yükseliş 125
  const p3 = ledge(950, 1240, 570, 90);     // boşluk 170, yükseliş 120
  const p4 = ledge(1390, 1670, 455, 90);    // boşluk 150, yükseliş 115
  return {
    name: 'İlk Işık',
    tip: 'Basılı tut, geriye çek ve bırak.',
    w: 1660, h: 1060,
    bg: ['#141a44', '#06091c'], accent: [120, 170, 255],
    spawn: { x: 120, y: 770 },
    gate: gateOn(p4, 1540),
    solids: [floor, p1, p2, p3, p4],
    route: [at(p1, 120), at(p2, 580), at(p3, 1030), at(p4, 1470), [0, 0, 'gate']],
  };
})());

/* === 2. Yükseklik ==========================================================
   Duvara tutunma. İki kez ortaya çıkar: önce, düşmenin hiçbir bedeli olmadığı
   dünyanın ortasındaki küçük bir çıkıntıda; sonra bölümün kendisi olan
   kulede. Kulenin tepesi hedeftir ve oyuncu tırmanışa girişmeden önce
   altındaki çıkıntıdan görünür haldedir.
   Hedef: 1.5/10. */
LEVELS.push((() => {
  const floor = ledge(0, 1500, 1330, 150);
  const p1 = ledge(-20, 320, 1180, 130);
  const stub = tower(440, 610, 930, 1330);   // pratik yüz, tepe 930'da
  const p2 = ledge(760, 1080, 900, 90);      // iki tutunma arasında düz bir dinlenme
  const keep = tower(1170, 1410, 480, 1330); // kule: tepe 480'de
  return {
    name: 'Tutun',
    tip: 'Duvara değ ve tutun. Sonra yukarı bırak.',
    w: 1500, h: 1440,
    bg: ['#102542', '#040a18'], accent: [90, 190, 255],
    spawn: { x: 110, y: 1135 },
    gate: gateOn(keep),
    solids: [floor, p1, stub, p2, keep],
    route: [
      at(p1, 110),
      grip(stub, -1, 1030),
      at(stub, 540),
      at(p2, 850),
      grip(keep, -1, 700),
      at(keep),
      [0, 0, 'gate'],
    ],
  };
})());

/* === 3. Yankı ==============================================================
   Enerji düğümleri. Bir düğüm seni yalnızca onun için basarsan yakalar; bu
   yüzden ilki, zaten çalışan bir sıçramanın üzerine basitçe oturabilir:
   oyuncu ona uzanmadıkça hiçbir şey olmaz, ders de tam olarak ona uzanmaktır.
   İkincisi bölümün kendisidir — son çıkıntı 417 birim yukarıdadır, durarak
   yapılan bir sıçramanın erişebileceğinin ötesindedir ve düğüm ona ulaşmanın
   tek yoludur.
   Hedef: 2/10. */
LEVELS.push((() => {
  const floor = ledge(0, 1660, 1010, 140);
  const p1 = ledge(-20, 350, 870, 120);
  const p2 = ledge(620, 1010, 760, 90);      // yakın kenarına 410, yükseliş 110
  const p3 = ledge(1320, 1700, 400, 90);     // aşağıdaki çıkıntıdan erişilemez
  const spare = { x: 480, y: 690 };          // görmezden gelmek serbest; keşfetmek serbest
  const lift = { x: 1060, y: 640 };
  return {
    name: 'Yankı',
    tip: 'Havada küreye bas. Seni tutar, yeniden nişan al.',
    w: 1740, h: 1120,
    bg: ['#231640', '#08061c'], accent: [170, 130, 255],
    spawn: { x: 250, y: 825 },
    gate: gateOn(p3, 1540),
    solids: [floor, p1, p2, p3],
    nodes: [spare, lift],
    route: [at(p1, 250), at(p2, 900), via(lift), at(p3, 1540), [0, 0, 'gate']],
  };
})());

/* === 4. Sıçrama ============================================================
   Yaylar. İlkine, yakınında hiçbir şey olmayan 90 birimlik bir sıçramayla
   varılır ve oyuncuyu 450 genişliğinde bir rafa fırlatır — yanlış
   okunması mümkün değildir. İkincisi ters yöne nişanlıdır ve bölümü kendi
   üzerine katlar: bıraktığı raf, iniş noktasının 467 birim altındadır; bu
   yüzden fırlatma yukarı çıkmanın tek yoludur ve dünya sağa doğru
   uzaklaşmak yerine kompakt kalır.
   Hedef: 2.5/10. */
LEVELS.push((() => {
  const floor = ledge(0, 1500, 1440, 150);
  const p1 = ledge(-20, 330, 1300, 120);
  const pad = ledge(420, 830, 1200, 110);            // buraya sakince var
  const s1 = { x: 690, y: 1176, w: 172, h: 44, a: 16 };
  const shelf = ledge(1050, 1500, 880, 120);         // 450 birimlik güvenlik
  const s2 = { x: 1400, y: 856, w: 170, h: 44, a: -14 };
  const p4 = ledge(800, 1180, 400, 110);     // fırlatmanın yükselen yayından uzak
  const p5 = ledge(300, 700, 290, 100);
  return {
    name: 'Sıçrama',
    tip: 'Yeşil yüzey, baktığı yöne fırlatır.',
    w: 1500, h: 1560,
    bg: ['#0d2c34', '#040f18'], accent: [90, 220, 190],
    spawn: { x: 110, y: 1255 },
    gate: gateOn(p5, 450),
    solids: [floor, p1, pad, shelf, p4, p5],
    springs: [s1, s2],
    route: [
      at(p1, 110), at(pad, 520), onto(s1), at(shelf, 1160),
      onto(s2), at(p4, 1040), at(p5, 450), [0, 0, 'gate'],
    ],
  };
})());

/* === 5. Kızıl yol ==========================================================
   Tehlike ve ilk seçim. Diken yatağı, oyuncunun zaten düzinelerce kez
   yaptığı bir sıçramanın 135 birim altındadır; bu yüzden önemli olmadan çok
   önce görülür. Sonra bölüm ikiye ayrılır: çukurun üzerinden iki kısa
   güvenli sıçrama için bir basamak taşı, ya da doğrudan üzerinden 520
   birimlik tek bir geçiş. Uzun yol bir ceza değildir, kısa yol da bir tuzak
   değildir — bu yalnızca oyuncunun ilk kez bir şeye karar verdiği andır.
   Hedef: 3/10. */
LEVELS.push((() => {
  const floor = ledge(-20, 960, 1070, 130);          // sadece yakın yarısı
  const p1 = ledge(-20, 400, 830, 130);
  const p2 = ledge(560, 950, 790, 100);
  const stone = ledge(1030, 1220, 800, 70);          // temkinli geçiş yolu
  const p4 = ledge(1300, 1760, 700, 110);
  return {
    name: 'Kızıl Yol',
    tip: 'Kırmızıya dokunma. İki yol da geçer.',
    w: 1780, h: 1180,
    bg: ['#2a1330', '#0a0418'], accent: [220, 120, 220],
    spawn: { x: 240, y: 785 },
    gate: gateOn(p4, 1660),
    solids: [floor, p1, p2, stone, p4],
    spikes: [{ x: 1125, y: 965, w: 330, h: 70 }],
    route: [at(p1, 240), at(p2, 860), at(stone, 1120), at(p4, 1400), [0, 0, 'gate']],
    fastRoute: [at(p1, 240), at(p2, 860), at(p4, 1400), [0, 0, 'gate']],
  };
})());

/* === 6. Nabız ==============================================================
   Işınlar ve bir yürüyüş yerine bir baca gibi şekillendirilmiş ilk bölüm.
   Her geçiş, oyuncunun istediği kadar üzerinde durabileceği geniş bir
   çıkıntıdan yapılır — bir gerilme tutulduğu sürece dünya donar, bu yüzden
   ışını saymanın hiçbir bedeli yoktur. 1.3 saniye yanık, 3.5 saniye sönük.

   İlk sıçrama ilk ışının ALTINDAN geçer, son sıçrama ise ikincisinin
   ÜZERİNDEN uçar: bölüm hiçbir şey istemeden tehlikeyi göstererek açılır ve
   oyuncunun öğrendiğini onu görmezden gelmek için kullanmasına izin vererek
   kapanır.
   Hedef: 3.5/10. */
LEVELS.push((() => {
  const floor = ledge(-20, 1060, 2120, 120);
  const p1 = ledge(-20, 400, 2040, 120);
  const watch = ledge(640, 1040, 1810, 110);   // burada dur ve say
  const p3 = ledge(-20, 460, 1580, 100);
  const p4 = ledge(600, 1040, 1350, 100);
  const p5 = ledge(-20, 460, 1120, 110);
  return {
    name: 'Nabız',
    tip: 'Işık sönünce geç. Beklemek serbest.',
    w: 1060, h: 2240,
    bg: ['#161a3a', '#050919'], accent: [140, 175, 245],
    spawn: { x: 220, y: 1995 },
    gate: gateOn(p5, 220),
    solids: [floor, p1, watch, p3, p4, p5],
    beams: [
      { x: 520, y: 1640, w: 28, h: 280, pulse: { period: 4.8, phase: 0, duty: 0.28 } },
      { x: 520, y: 1400, w: 28, h: 280, pulse: { period: 4.8, phase: 0.45, duty: 0.28 } },
    ],
    route: [
      at(p1, 220), at(watch, 860), at(p3, 200), at(p4, 820), at(p5, 200), [0, 0, 'gate'],
    ],
  };
})());

/* === 7. Salınım ============================================================
   Hareketli zemin. İlki, altında bir zemin olan bir boşluğu geçer, bir
   turu tamamlaması on saniye sürer ve 260 birim genişliğindedir — oyuncu
   ondan önceki çıkıntıdan istediği kadar izleyebilir ve onu kaçırmak bir
   can değil, kısa bir tırmanışa mal olur. İkincisi dikey hareket eder; bu
   aynı fikrin diğer eksende okunmuş halidir.
   Hedef: 4/10. */
LEVELS.push((() => {
  const floor = ledge(-20, 1820, 1140, 120);
  const p1 = ledge(-20, 420, 880, 130);
  const watch = ledge(520, 850, 820, 110);
  const m1 = ledge(1000, 1260, 755, 70, { motion: { type: 'osc', dx: 130, dy: 0, period: 10 } });
  const p3 = ledge(1420, 1800, 780, 110);
  const m2 = ledge(1160, 1400, 455, 70, { motion: { type: 'osc', dx: 0, dy: 90, period: 9 } });  // aşağıdaki çıkıntının üzerinden açık
  const p4 = ledge(820, 1140, 180, 110);     // ondan önceki çıkıntının 600 üstünde: ya bin ya da hiç
  return {
    name: 'Salınım',
    tip: 'Zemin geliyor. Acele etme, izle.',
    w: 1820, h: 1260,
    bg: ['#10203c', '#040a18'], accent: [110, 200, 235],
    spawn: { x: 110, y: 835 },
    gate: gateOn(p4, 980),
    solids: [floor, p1, watch, m1, p3, m2, p4],
    route: [
      at(p1, 110), at(watch, 780), at(m1), at(p3, 1600), at(m2), at(p4, 980), [0, 0, 'gate'],
    ],
  };
})());

/* === 8. Kırılgan ===========================================================
   Çöken zemin. İlki, altında bir zemin ve 2.2 saniyelik bir çatlama süresi
   olan bir inişdir; bu yüzden ders bedelsizdir: üzerinde dur, başarısız
   olmasını izle, çatlakların ne anlama geldiğini anla.

   Yukarıdaki çift bölümün kendisidir. Ortadaki çıkıntı ile tepe arasında
   440 birimlik bir tırmanış ve üzerinde durulacak başka hiçbir şey yoktur;
   bu yüzden iki çöken basamak bir sapma değil, çıkış yoludur — ve ikisi de
   atlanamaz, çünkü ilkinden tepeye hâlâ 387 birim vardır ve durarak yapılan
   bir sıçrama neredeyse hiç menzil bırakmadan 405'te tepe yapar. Zemin yine
   de her şeyin altında uzanır; bu yüzden yanlış yapmak yalnızca tırmanışa
   mal olur, asla bölüme değil.
   Hedef: 4.5/10. */
LEVELS.push((() => {
  const floor = ledge(-20, 1440, 1080, 120);
  const p1 = ledge(-20, 400, 900, 130);
  const c1 = ledge(520, 820, 840, 80, { crumble: 2.2 });    // güvenli: altında bir zemin var
  const p2 = ledge(960, 1300, 800, 110);
  const c2 = ledge(700, 920, 620, 70, { crumble: 1.8 });
  const c3 = ledge(500, 720, 470, 70, { crumble: 1.8 });
  const p3 = ledge(40, 380, 300, 110);     // çapraz bir sıçrama, yüzü boyunca bir tırmanış değil
  return {
    name: 'Kırılgan',
    tip: 'Çatlarsa kalma. Ama telaş da etme.',
    w: 1440, h: 1200,
    bg: ['#2b1b2e', '#0b0616'], accent: [215, 160, 200],
    spawn: { x: 110, y: 855 },
    gate: gateOn(p3, 200),
    solids: [floor, p1, c1, p2, c2, c3, p3],
    route: [
      at(p1, 110), at(c1, 670), at(p2, 1100), at(c2, 810), at(c3, 610), at(p3, 200), [0, 0, 'gate'],
    ],
  };
})());

/* === 9. Akış ===============================================================
   İlk gerçek kombinasyon ve bilerek bir hassasiyet testi değil: bir duvara
   tutun, tepesinden geç, karşıya adım at ve fırlatıl. Burada hiçbir şey
   tehlikeli değildir. Buradaki nokta, oyuncunun artık bildiği dört şeyin
   tek bir sürekli harekette birleşmesidir ve bu, kendini bunda ilk kez iyi
   hissedeceği bölüm olmalıdır.
   Hedef: 5/10. */
LEVELS.push((() => {
  const floor = ledge(-20, 1300, 1830, 130);
  const p1 = ledge(-20, 420, 1760, 130);
  const keep = tower(560, 740, 1320, 1830);
  const p2 = ledge(820, 1260, 1280, 100);    // yayın YANINA inecek yer
  const s1 = { x: 1150, y: 1256, w: 170, h: 44, a: -14 };
  const p3 = ledge(500, 940, 820, 110);      // sağ kenarı yükselen yaydan uzak tutulmuş
  const p4 = ledge(80, 400, 640, 100);
  return {
    name: 'Akış',
    tip: 'Tutun, tırman, fırla. Hepsi tek bir hareket.',
    w: 1300, h: 1900,
    bg: ['#0e2b3a', '#040f1a'], accent: [95, 210, 220],
    spawn: { x: 120, y: 1715 },
    gate: gateOn(p4, 240),
    solids: [floor, p1, keep, p2, p3, p4],
    springs: [s1],
    route: [
      at(p1, 120), grip(keep, -1, 1580), at(keep), at(p2, 880),
      onto(s1), at(p3, 760), at(p4, 240), [0, 0, 'gate'],
    ],
  };
})());

/* === 10. Kement ============================================================
   Hareketli zemin üzerinde bir düğüm. Düğümde tutulduğunda dünya donar; bu
   yüzden oyuncu platformun tüm yolunu izleyip bırakma anını seçebilir —
   asıl nokta da budur: bu hızlı değil, akıllıca hissettirmelidir. İlk
   bölümden sonra zemin kesilir; bu yüzden uzak çıkıntıdaki kontrol noktası,
   ikinci yarının tüm bölüme değil, yalnızca birkaç saniyeye mal olmasını
   sağlayan şeydir.
   Hedef: 5.5/10. */
LEVELS.push((() => {
  const floor = ledge(-20, 960, 1290, 120);          // sadece yakın yarısı
  const p1 = ledge(-20, 400, 1080, 130);
  const watch = ledge(520, 900, 1000, 110);
  const hold = { x: 1060, y: 820 };
  const m1 = ledge(1080, 1320, 865, 70, { motion: { type: 'osc', dx: 0, dy: 150, period: 8 } });
  const p3 = ledge(1420, 1800, 780, 110);
  const m2 = ledge(1000, 1220, 565, 70, { motion: { type: 'osc', dx: 140, dy: 0, period: 7 } });
  const p4 = ledge(420, 800, 290, 110);      // düğümün erişiminin dışında: yol asansörden geçer
  return {
    name: 'Kement',
    tip: 'Küredeyken dünya durur. Zamanını seç.',
    w: 1820, h: 1400,
    bg: ['#22183f', '#07051a'], accent: [190, 150, 250],
    spawn: { x: 110, y: 1035 },
    gate: gateOn(p4, 610),
    solids: [floor, p1, watch, m1, p3, m2, p4],
    nodes: [hold],
    motes: [checkOn(p3, 1500)],
    route: [
      at(p1, 110), at(watch, 800), via(hold), at(m1), at(p3, 1600), at(m2), at(p4, 610),
      [0, 0, 'gate'],
    ],
  };
})());

/* === 11. Akıntı ============================================================
   Rüzgâr, üç kez, oyuncunun ihtiyaç duyduğu sırayla.

     HİSSET    440 genişliğindeki bir çıkıntının üzerinde zayıf bir yanal
               akıntı; böylece yayın hiçbir şey ona bağlı olmadan
               eğrildiği izlenebilir.
     KARŞI ÇIK aynı türden bir akıntı, ama yanlış yöne iter; nişanın onun
               içine yaklaşık 120 birim alınması gereken bir sıçramada.
     BİN     yayı kabaca ikiye katlayan yükselen bir akıntı. Götürdüğü raf
               460 birim yukarıdadır; hiçbir durarak yapılan sıçrama oraya
               erişemez, bu yüzden akıntı bir kısayol değil — tek yoldur.

   Bir akıntı yer çekiminden her zaman daha zayıftır: bir sıçramayı büker,
   asla onu tamamen alıp götürmez. Ve zemin burada tüm genişlik boyunca
   uzanır, çünkü bu bölüm cezalandırılmakla değil, havayı okumayı
   öğrenmekle ilgilidir.
   Hedef: 6/10. */
LEVELS.push((() => {
  const floor = ledge(-20, 1500, 1450, 120);
  const p1 = ledge(-20, 400, 1280, 130);
  const p2 = ledge(620, 1060, 1180, 110);            // 440 genişlik: sürüklenme ıskalayamaz
  const p3 = ledge(120, 560, 980, 110);
  const p4 = ledge(860, 1400, 520, 130);             // akıntının üzerindeki raf
  return {
    name: 'Akıntı',
    tip: 'Akıntı seni taşır. Ona göre nişan al.',
    w: 1500, h: 1560,
    bg: ['#0c2b33', '#030f16'], accent: [80, 215, 210],
    spawn: { x: 230, y: 1235 },
    gate: gateOn(p4, 1200),
    solids: [floor, p1, p2, p3, p4],
    winds: [
      { x: 700, y: 1180, w: 420, h: 300, dx: 1, dy: 0, strength: 0.05 },   // hisset
      { x: 640, y: 960, w: 420, h: 280, dx: 1, dy: 0, strength: 0.07 },    // karşı çık
      { x: 700, y: 700, w: 520, h: 520, dx: 0, dy: -1, strength: 0.26 },   // bin
    ],
    route: [
      at(p1, 230), at(p2, 860), at(p3, 300), at(p3, 480),
      // biniş: taşınır, bu yüzden menzili durgun havada ölçülen bir zarfla
      // değil, gerçekten uçurularak denetlenir
      [at(p4, 1100)[0], at(p4, 1100)[1], 'ground', 'wind'],
      [0, 0, 'gate'],
    ],
  };
})());

/* === 12. Döngü =============================================================
   Yay ve ışın, sırayla; bölüm bir müzik ölçüsü gibi okunur:

     dinlen -> fırlatıl -> in -> hareketsiz durup say -> geç -> dinlen

   ...iki kez. Her ışınla, üzerinde hiçbir şey olmayan bir çıkıntıdan
   karşılaşılır ve her yay fırlatmasının tüm yolu boyunca açık hava vardır;
   bu yüzden iki mekanik asla aynı anda bir şey istemez. Bunu bir tepki
   testi değil bir ritim yapan da budur.

   Kontrol noktası ortadaki çıkıntıda oturur; böylece çözülmüş yarı, çözülü
   kalır.
   Hedef: 6.5/10. */
LEVELS.push((() => {
  const floor = ledge(-20, 1000, 1830, 130);         // sadece yakın taraf
  const p1 = ledge(-20, 400, 1740, 130);
  const p2 = ledge(560, 960, 1660, 110);
  const s1 = { x: 820, y: 1636, w: 170, h: 44, a: 12 };
  const p3 = ledge(1060, 1500, 1330, 100);
  const p4 = ledge(280, 780, 1090, 110);             // ışının soluna in, dinlen
  const s2 = { x: 380, y: 1066, w: 170, h: 44, a: 16 };
  const p5 = ledge(700, 1140, 760, 100);
  const p6 = ledge(1260, 1700, 560, 110);
  return {
    name: 'Döngü',
    tip: 'Bekle, fırla, in, say, geç.',
    w: 1740, h: 1900,
    bg: ['#1c1436', '#060418'], accent: [160, 150, 245],
    spawn: { x: 230, y: 1695 },
    gate: gateOn(p6, 1560),
    solids: [floor, p1, p2, p3, p4, p5, p6],
    springs: [s1, s2],
    beams: [
      { x: 820, y: 1180, w: 28, h: 240, pulse: { period: 4.2, phase: 0, duty: 0.30 } },
      { x: 1200, y: 640, w: 28, h: 220, pulse: { period: 4.0, phase: 0.35, duty: 0.32 } },
    ],
    motes: [checkOn(p4, 620)],
    route: [
      at(p1, 230), at(p2, 620), onto(s1), at(p3, 1185), at(p4, 600),
      onto(s2), at(p5, 850), at(p6, 1400), [0, 0, 'gate'],
    ],
  };
})());

/* === 13. Ayrım =============================================================
   Bir uçurum, bir merkez, üzerinden geçmenin iki dürüst yolu.

   Sabırlı yol önce AŞAĞI iner: çöken bir basamağa düş, o gitmeden önce
   ayrıl, asansörle geri yukarı çık, in. Üç sıçrama, oyuncunun daha önce
   yapmadığı hiçbir şey yok ve tek baskı 1.6 saniyelik çatlama süresi.

   Cesur yol ikidir: boşluğun üzerinden 400 birimlik bir sıçrayışla bir
   düğüme, sonra oradan uzak rafa tek bir fırlatma. Açık havada gerçek bir
   kararlılık ister — ve bölümde yanlış yapmanın tüm geçişe mal olduğu tek
   yer burasıdır.

   İkisi de makuldür. Ustalık, kazanılan sıçramalarla ödenir; bu oyunun
   sahip olduğu tek para birimi budur.
   Hedef: 7/10. */
LEVELS.push((() => {
  const floor = ledge(-20, 1000, 1390, 120);         // sadece yakın taraf
  const p1 = ledge(-20, 400, 1200, 130);
  const hub = ledge(540, 980, 1120, 120);            // çatal ve kontrol noktası
  const step = ledge(1060, 1260, 1240, 70, { crumble: 1.6 });
  const lift = ledge(1320, 1560, 1140, 70, { motion: { type: 'osc', dx: 0, dy: 120, period: 8 } });
  const bold = { x: 1300, y: 900 };                  // kısa yolun tamamı
  const far = ledge(1640, 2040, 820, 110);           // asansörün hareketinden uzak
  const p6 = ledge(1240, 1620, 560, 110);
  return {
    name: 'Ayrım',
    tip: 'İki yol var. İkisi de doğru.',
    w: 2080, h: 1520,
    bg: ['#2a1526', '#0b0514'], accent: [230, 140, 180],
    spawn: { x: 230, y: 1155 },
    gate: gateOn(p6, 1420),
    solids: [floor, p1, hub, step, lift, far, p6],
    nodes: [bold],
    motes: [checkOn(hub, 760)],
    route: [
      at(p1, 230), at(hub, 860), at(step, 1160), at(lift), at(far, 1760),
      at(p6, 1400), [0, 0, 'gate'],
    ],
    fastRoute: [
      at(p1, 230), at(hub, 860), via(bold), at(far, 1760), at(p6, 1400), [0, 0, 'gate'],
    ],
  };
})());

/* === 14. Tırmanış ==========================================================
   İlk uzun bölüm ve bir rampa değil, bir dalga:

     duvar    -> DİNLEN -> hareketli zemin -> KONTROL NOKTASI
     akıntı ve düğüm (zor bölüm) -> DİNLEN
     bir tehlikenin üzerinde yay -> KONTROL NOKTASI -> kısa bir duvar, ve çıkış

   Adlandırılmış her DİNLEN, üzerinde hiçbir şey olmayan geniş bir
   çıkıntıdır ve iki kontrol noktası, bir hatanın en kötü bedeli tek bir
   bölüm olacak şekilde yerleştirilmiştir.

   Diken yatağı üst odanın zeminidir: orada olan her şeyin altındadır ve
   hiçbir şeyin yolunda değildir; bu yüzden bir tuzak değil, dikkatli olmak
   için bir sebep olarak okunur.
   Hedef: 7.5/10. */
LEVELS.push((() => {
  const floor = ledge(-20, 1250, 2930, 130);
  const p1 = ledge(-20, 380, 2800, 120);
  const keep = tower(550, 730, 2340, 2860);
  const rest1 = ledge(840, 1240, 2230, 110);
  const m1 = ledge(585, 815, 2065, 70, { motion: { type: 'osc', dx: 150, dy: 0, period: 8 } });
  const camp1 = ledge(120, 620, 1900, 100);
  const hold = { x: 820, y: 1650 };
  const rest2 = ledge(180, 640, 1500, 110);          // 460 genişlik ve yalnızca 160 yükseklik
  const s1 = { x: 520, y: 1476, w: 170, h: 44, a: 12 };
  const camp2 = ledge(760, 1200, 1080, 110);
  const last = tower(360, 560, 640, 1060);
  const p6 = ledge(640, 1040, 460, 110);
  return {
    name: 'Tırmanış',
    tip: 'Uzun bir tırmanış. Aralarda dinlen.',
    w: 1250, h: 3000,
    bg: ['#141d3e', '#05081a'], accent: [130, 180, 250],
    spawn: { x: 110, y: 2755 },
    gate: gateOn(p6, 840),
    solids: [floor, p1, keep, rest1, m1, camp1, rest2, camp2, last, p6],
    springs: [s1],
    nodes: [hold],
    winds: [{ x: 640, y: 1700, w: 360, h: 320, dx: 1, dy: 0, strength: 0.055 }],
    spikes: [{ x: 1060, y: 1500, w: 280, h: 60 }],   // oda zemini, asla bir yay değil
    motes: [checkOn(camp1, 300), checkOn(camp2, 1060)],   // akıntıdan uzak
    route: [
      at(p1, 110), grip(keep, -1, 2600), at(keep), at(rest1, 1000),
      at(m1), at(camp1, 360), via(hold), at(rest2, 320),
      onto(s1), at(camp2, 900), grip(last, 1, 900), at(last), at(p6, 840), [0, 0, 'gate'],
    ],
  };
})());

/* === 15. Son ışık ==========================================================
   Her şey, bir kez, aynı anda iki tanıdık olmayan şeyi hiç istemeyen bir
   sırayla. Gerçekten zor olmasına izin verilen tek bölümdür ve bu zorluk,
   tek bir halkanın hassasiyetinde değil, zincirin uzunluğundadır: burada
   hiçbir şey tam bir açı gerektirmez ve hiçbir şey önce kendini göstermeden
   öldürmez. Üç kontrol noktası, bir hatayı kendi bölümünün içinde tutar.

   Yarı yoldaki düğüm, üzerinde bir çatı olan alçak bir koridorda oturur. O
   çatı gerçek bir iş görüyor: bir enerji düğümü neredeyse bin birim
   fırlatır, bir bölümün çoğunu atlayacak kadar uzağa; tavan ise o fırlatmayı
   odanın istediği tek harekete geri çevirir — koridor boyunca dışarı,
   çöken basamağın üzerine ve yukarı.

   Kapanış zinciri — duvar, düğüm, yay, iniş — oyunun aralarında uygun bir
   dinlenme olmadan dört şey istediği tek yerdir.
   Hedef: 9/10. */
LEVELS.push((() => {
  const floor = ledge(-20, 700, 3260, 120);          // başlangıç, başka hiçbir şey değil
  const p1 = ledge(-20, 400, 3140, 120);
  const p2 = ledge(660, 940, 3020, 90);
  const w1 = tower(1020, 1400, 2740, 3100);          // tepesi yayın yanında durabilecek kadar geniş
  const s1 = { x: 1290, y: 2716, w: 170, h: 44, a: -16 };
  const camp1 = ledge(560, 980, 2440, 100);
  const m1 = ledge(310, 530, 2285, 70, { motion: { type: 'osc', dx: 0, dy: 130, period: 7 } });
  const turn = { x: 300, y: 1880 };                  // yalnızca asansör oraya ulaşır
  const roof = ledge(120, 740, 1700, 80);            // fırlatmayı şekillendiren tavan
  const c1 = ledge(760, 1000, 1870, 70, { crumble: 1.5 });
  const camp2 = ledge(1340, 1640, 1760, 100);
  const p5 = ledge(900, 1260, 1560, 100);
  const p6 = ledge(300, 680, 1400, 100);
  const w3 = tower(555, 725, 960, 1160);    // yüzleri aşağıdaki çıkıntının erişiminin dışında
  const m2 = ledge(960, 1160, 1035, 70, { motion: { type: 'osc', dx: 160, dy: 0, period: 6.5 } });
  const camp3 = ledge(1180, 1520, 860, 100);
  const w4 = tower(740, 900, 560, 860);
  const last = { x: 520, y: 560 };
  const p8 = ledge(180, 460, 700, 90);
  const s2 = { x: 320, y: 676, w: 170, h: 44, a: 18 };
  const p9 = ledge(700, 1060, 300, 100);
  return {
    name: 'Son Işık',
    tip: 'Bildiğin her şey. Sırayla.',
    w: 1740, h: 3400,
    bg: ['#1a1030', '#050310'], accent: [235, 200, 255],
    spawn: { x: 240, y: 3095 },
    gate: gateOn(p9, 880),
    solids: [floor, p1, p2, w1, camp1, m1, roof, c1, camp2, p5, p6, w3, m2, camp3, w4, p8, p9],
    springs: [s1, s2],
    nodes: [turn, last],
    winds: [{ x: 1060, y: 1540, w: 360, h: 340, dx: -1, dy: 0, strength: 0.06 }],
    beams: [{ x: 800, y: 1450, w: 28, h: 260, pulse: { period: 3.8, phase: 0, duty: 0.32 } }],
    motes: [checkOn(camp1, 860), checkOn(camp2, 1500), checkOn(camp3, 1360)],
    route: [
      at(p1, 240), at(p2, 800), grip(w1, -1, 2800), at(w1, 1100),
      onto(s1), at(camp1, 860), at(m1), via(turn), at(c1, 880), at(camp2, 1500),
      at(p5, 1080), at(p6, 400), grip(w3, -1, 1100), at(w3),
      at(m2), at(camp3, 1260), grip(w4, 1, 800), at(w4),
      via(last), onto(s2), at(p9, 840), [0, 0, 'gate'],
    ],
  };
})());

/* ============================================================
   5. DÜNYA OLUŞTURMA
   ============================================================ */

const world = {
  solids: [],   // güvenli yüzeyler — ruhun üzerine inebileceği ya da tutunabileceği her şey
  springs: [],
  nodes: [],
  motes: [],
  lethal: [],   // dikenler ve ışınlar
  beams: [],
  movers: [],
  winds: [],
  gate: null,
  w: VW, h: VH,
  bg: ['#141a44', '#06091c'],
  accent: [120, 170, 255],
};

const ENTITY_KINDS = {
  solid:  { list: 'solids',  init: (e) => { e.crumbleT = -1; e.broken = false; } },
  spring: { list: 'springs', init: (e) => { e.fire = 0; e.lock = false; e.off = false; e.cool = 0; } },
  node:   { list: 'nodes',   init: (e) => { e.r = e.r || 26; e.cool = 0; e.glow = 0; e.spin = 0; } },
  mote:   { list: 'motes',   init: (e) => { e.r = e.r || 20; e.got = false; e.pop = 0; } },
  spike:  { list: 'lethal',  init: (e) => { e.spikes = true; } },
  beam:   { list: 'lethal',  also: 'beams', init: (e) => { e.k = 1; } },
};

function prepEntity(e, kind) {
  e.kind = kind;
  e.a = (e.a || 0) * DEG;
  e.bx = e.x; e.by = e.y; e.ba = e.a;
  e.px = e.x; e.py = e.y;
  e.vx = 0; e.vy = 0; e.av = 0;
  e.seed = Math.random() * 100;
  e.gfx = {};
  e.ca = Math.cos(e.a); e.sa = Math.sin(e.a);
  e.br = e.w !== undefined ? Math.hypot(e.w, e.h) / 2 : (e.r || 26);
  const spec = ENTITY_KINDS[kind];
  if (spec && spec.init) spec.init(e);
  return e;
}

function addEntity(e, kind) {
  prepEntity(e, kind);
  const spec = ENTITY_KINDS[kind];
  if (spec.list) world[spec.list].push(e);
  if (spec.also) world[spec.also].push(e);
  if (e.motion) world.movers.push(e);
  return e;
}

function buildWorld(src) {
  const L = clone(src);
  world.solids.length = 0; world.springs.length = 0; world.nodes.length = 0;
  world.motes.length = 0; world.lethal.length = 0; world.beams.length = 0;
  world.movers.length = 0;
  world.winds = L.winds || [];
  world.w = L.w; world.h = L.h;
  world.bg = L.bg; world.accent = L.accent;

  for (const e of (L.solids  || [])) addEntity(e, 'solid');
  for (const e of (L.springs || [])) addEntity(e, 'spring');
  for (const e of (L.nodes   || [])) addEntity(e, 'node');
  for (const e of (L.motes   || [])) addEntity(e, 'mote');
  for (const e of (L.spikes  || [])) addEntity(e, 'spike');
  for (const e of (L.beams   || [])) addEntity(e, 'beam');

  world.gate = prepEntity(Object.assign({ r: 40 }, L.gate), 'gate');
  world.gate.open = 0;
  return L;
}

function updateMotion(t) {
  for (const e of world.movers) {
    e.px = e.x; e.py = e.y;
    const pa = e.a;
    const m = e.motion;
    if (m.type === 'osc') {
      const ph = Math.sin((t / m.period + (m.phase || 0)) * TAU);
      e.x = e.bx + (m.dx || 0) * ph;
      e.y = e.by + (m.dy || 0) * ph;
    } else if (m.type === 'spin') {
      e.a = e.ba + m.speed * t;
    } else if (m.type === 'sweep') {
      e.a = e.ba + (m.amp || 1) * Math.sin((t / m.period + (m.phase || 0)) * TAU);
    }
    if (e.a !== pa) { e.ca = Math.cos(e.a); e.sa = Math.sin(e.a); }
    e.vx = e.x - e.px; e.vy = e.y - e.py; e.av = e.a - pa;
  }
}

/* Nabız atan bir ışının şu anda ne kadar aydınlık olduğu: 0 sönük, 1
   öldürücü. Yükseliş, vuruşu önceden haber verir; böylece bir ölüm her
   zaman oyuncunun kaçınabileceği bir şeydir. */
function beamLevel(h, t) {
  if (!h.pulse) return 1;
  const p = h.pulse;
  const u = ((t / p.period) + (p.phase || 0)) % 1;
  const duty = p.duty || 0.42;
  if (u > duty) {
    const rem = (1 - u) / (1 - duty);
    return rem < 0.22 ? (0.22 - rem) / 0.22 * 0.34 : 0;
  }
  const ramp = 0.1;
  if (u < duty * ramp) return 0.34 + (u / (duty * ramp)) * 0.66;
  if (u > duty * (1 - ramp)) return 1 - ((u - duty * (1 - ramp)) / (duty * ramp)) * 0.7;
  return 1;
}

/* ============================================================
   6. ÇARPIŞMA VE HAREKET
   ============================================================ */

function circleVsBox(px, py, r, e) {
  const dx = px - e.x, dy = py - e.y;
  // geniş faz: kutunun sınırlayıcı çemberine karşı tek bir kare-mesafe testi
  const reach = e.br + r;
  if (dx * dx + dy * dy > reach * reach) return null;
  const ca = e.ca, sa = -e.sa;
  const lx = dx * ca - dy * sa;
  const ly = dx * sa + dy * ca;
  const hw = e.w / 2, hh = e.h / 2;
  const qx = clamp(lx, -hw, hw), qy = clamp(ly, -hh, hh);
  const ddx = lx - qx, ddy = ly - qy;
  const d2 = ddx * ddx + ddy * ddy;
  if (d2 > r * r) return null;
  let nx, ny, pen;
  if (d2 > 1e-7) {
    const d = Math.sqrt(d2);
    nx = ddx / d; ny = ddy / d; pen = r - d;
  } else {
    const ox = hw - Math.abs(lx), oy = hh - Math.abs(ly);
    if (ox < oy) { nx = lx < 0 ? -1 : 1; ny = 0; pen = ox + r; }
    else { nx = 0; ny = ly < 0 ? -1 : 1; pen = oy + r; }
  }
  const cb = e.ca, sb = e.sa;
  HIT.nx = nx * cb - ny * sb;
  HIT.ny = nx * sb + ny * cb;
  HIT.pen = pen;
  return HIT;
}
const HIT = { nx: 0, ny: 0, pen: 0 };

function overlapsBox(px, py, r, e) { return circleVsBox(px, py, r, e) !== null; }

/* Bir beden bu kutunun ETKİNLEŞTİRME bölgesinde mi — yani her tarafı `pad`
   kadar büyütülmüş kutunun kendisinde mi? `overlapsBox` "dokunuyor mu"
   sorusuna cevap verir; bu ise farklı bir soruya, "hâlâ etrafta mı"
   sorusuna cevap verir; bir yayın yeniden kurulması buna bağlıdır. Kimsenin
   istemediği normal olmadan, circleVsBox ile aynı matematik. */
function nearBox(px, py, r, e, pad) {
  const dx = px - e.x, dy = py - e.y;
  const reach = e.br + r + pad;
  if (dx * dx + dy * dy > reach * reach) return false;
  const ca = e.ca, sa = -e.sa;
  const lx = dx * ca - dy * sa;
  const ly = dx * sa + dy * ca;
  const hw = e.w / 2 + pad, hh = e.h / 2 + pad;
  const qx = clamp(lx, -hw, hw), qy = clamp(ly, -hh, hh);
  const ddx = lx - qx, ddy = ly - qy;
  return ddx * ddx + ddy * ddy <= r * r;
}

/* --- temas biriktiricisi ----------------------------------------------------
   Bir alt adım sırasında dokunulan her yüzey buraya düşer. Her temas
   bulundukça konum düzeltilir, böylece beden asla çakışık kalmaz; ama hız
   tepkisi ertelenir ve birleşik normale karşı yalnızca bir kez uygulanır.

   Köşelerin düzgün davranmasını sağlayan da budur: yüzeyleri birer birer
   çözmek bedeni aynı anda iki kez yansıtır; böylece sonuç listenin sırasına
   bağlı hale gelir ve bir pikselik fark ruhu her yere gönderebilir. */
const CT = {
  n: 0, closing: 0,
  nx: 0, ny: 0, wsum: 0,
  ovx: 0, ovy: 0,
  cnx: new Float64Array(6), cny: new Float64Array(6),
  cvx: new Float64Array(6), cvy: new Float64Array(6),
  reset() {
    this.n = 0; this.closing = 0;
    this.nx = 0; this.ny = 0; this.wsum = 0; this.ovx = 0; this.ovy = 0;
  },
  add(nx, ny, pen, ovx, ovy, closing) {
    if (this.n < 6) {
      const i = this.n++;
      this.cnx[i] = nx; this.cny[i] = ny;
      this.cvx[i] = ovx; this.cvy[i] = ovy;
    }
    if (!closing) return;
    const w = pen > 0.05 ? pen : 0.05;
    this.nx += nx * w; this.ny += ny * w;
    this.ovx += ovx * w; this.ovy += ovy * w;
    this.wsum += w;
    this.closing++;
  },
};

/* Bir hareket adımının neyle karşılaştığı.

   `wall`, "bir duvara dokunuldu" demektir — fizik ve geri bildirim bunu
   önemser. `wallHold` ise "tutunabileceğin bir duvar" demektir; bu, oyuncu
   durum mantığının sorduğu farklı bir sorudur: az önce fırladığın duvar
   kısa bir süre öyle sayılmaz, böylece bir çıkıntının üzerine sıçramak,
   aynı yüzeyin bir kare sonra seni tekrar yakalamasıyla bozulamaz. */
const RES = {
  floor: false, wall: false, wallHold: false, ceil: false,
  wallNx: 0, wallE: null,
  impact: 0, hx: 0, hy: 0, nx: 0, ny: 0,
  spring: null, lethal: null,
  reset() {
    this.floorE = null; this.floor = false; this.wall = false; this.wallHold = false; this.ceil = false;
    this.wallNx = 0; this.wallE = null;
    this.impact = 0; this.spring = null; this.lethal = null;
  },
};

const SV = { x: 0, y: 0 };
function surfaceVel(e, px, py) {
  SV.x = e.vx || 0; SV.y = e.vy || 0;
  if (e.av) { SV.x += -e.av * (py - e.y); SV.y += e.av * (px - e.x); }
  return SV;
}

function collectSolid(s, e) {
  if (e.broken) return;
  const hit = circleVsBox(s.x, s.y, s.r, e);
  if (!hit) return;
  const nx = hit.nx, ny = hit.ny;
  s.x += nx * (hit.pen + MOVE.slop);
  s.y += ny * (hit.pen + MOVE.slop);
  const sv = surfaceVel(e, s.x, s.y);
  if (s === body && PS.state === 'ground' && PS.support === e && e.motion) { sv.x = 0; sv.y = 0; }
  const vn = (s.vx - sv.x) * nx + (s.vy - sv.y) * ny;
  CT.add(nx, ny, hit.pen, sv.x, sv.y, vn < 0);

  // yüzeyi kendi normaline göre sınıflandır, böylece oyuncu mantığının
  // geometri hakkında akıl yürütmesi hiç gerekmez: yukarı bakan bir normal
  // üzerinde durulacak bir şeydir, aşağı bakan bir normal kafa çarpılacak
  // bir şeydir, başka her şey bir duvardır
  if (ny < -MOVE.floorDot) { RES.floor = true; RES.floorE = e; }
  else if (ny > MOVE.floorDot) RES.ceil = true;
  else if (!RES.wall || -vn > RES.impact) { RES.wall = true; RES.wallNx = nx; RES.wallE = e; }

  if (vn < 0 && -vn > RES.impact) {
    RES.impact = -vn; RES.nx = nx; RES.ny = ny;
    RES.hx = s.x - nx * s.r; RES.hy = s.y - ny * s.r;
  }
}

/* Alt adım başına bir hız tepkisi.

   Burada hiç geri sekme yoktur. Sıradan bir yüzey normal bileşenin
   tamamını alır ve kaymanın bir kısmını geri verir — ruh varır ve varmış
   olarak kalır. Ruhu dünyaya geri fırlatan her şey, kendi kuralı olan
   adlandırılmış bir nesnedir. */
function resolveContactVel(s) {
  if (CT.closing && CT.wsum > 0) {
    const len = Math.hypot(CT.nx, CT.ny);
    // sıfıra yakın bir birleşik normal, temasların birbirine karşı olduğu
    // anlamına gelir: beden sıkışmıştır ve aşağıdaki kayma geçişi tüm cevaptır
    if (len > CT.wsum * 0.2) {
      const nx = CT.nx / len, ny = CT.ny / len;
      const ovx = CT.ovx / CT.wsum, ovy = CT.ovy / CT.wsum;
      const rvx = s.vx - ovx, rvy = s.vy - ovy;
      const vn = rvx * nx + rvy * ny;
      if (vn < 0) {
        // ne kadar kaymanın hayatta kaldığı neye dokunulduğuna bağlıdır
        const keep = RES.floor ? MOVE.slideKeep : RES.ceil ? MOVE.ceilingKeep : MOVE.wallSlide;
        s.vx = (rvx - nx * vn) * keep + ovx;
        s.vy = (rvy - ny * vn) * keep + ovy;
      }
    }
  }
  // bir alt adım, dokunulan bir şeyin içine doğru hareket ederken asla bitmesin
  for (let i = 0; i < CT.n; i++) {
    const nx = CT.cnx[i], ny = CT.cny[i];
    const vn = (s.vx - CT.cvx[i]) * nx + (s.vy - CT.cvy[i]) * ny;
    if (vn < 0) { s.vx -= nx * vn; s.vy -= ny * vn; }
  }
}

/* Bir yay, yaklaşım ne olursa olsun kendi yüzeyi boyunca fırlatır. Yapısı
   gereği tahmin edilebilirdir: üzerine çizilen ok, tam olarak gideceğin
   yeri gösterir.

   TEK TEMAS, TEK FIRLATMA. Bunun korunduğu başarısızlık, ruhun az önce onu
   fırlatan yaya geri düşmesi ve aralarında hiçbir girdi olmadan tekrar
   fırlatılmasıdır — oyuncunun çıkamayacağı bir döngü, çünkü havada olmak
   ona hiçbir kontrol vermeyen tek durumdur.

   Bu yüzden ateşlenen bir yay, fırlattığı bedene kilitlenir. O beden
   etkinleştirme bölgesinden (çarpışma kutusunun her tarafından `springExit`
   kadar) çıkana kadar bir daha hiç ateşlenmez; onu açan tek şey
   `releaseSprings`'tir. Tek başına bir zamanlayıcı bunu yapamaz — oyuncu bir
   yayın üzerinde süresiz oturabilir — bu yüzden buradaki zamanlayıcı, birkaç
   kare içinde dışarı fırlatılıp geri gelen bir beden için yalnızca ikincil
   bir güvencedir.

   `live`, oyuncuyu nişan önizlemesinden ayırır: önizleme de aynı fonksiyonu
   çalıştırır, böylece noktalı kılavuz yayların farkında olur; ama kilidi
   yalnızca okumalı, asla yazmamalıdır — kılavuzun sönük gördüğü bir yay,
   kılavuzun seni onun içinden düşerken çizdiği bir yaydır ki gerçekte de
   tam olarak bu olacaktır. */
function fireSpring(s, sp, live) {
  if (sp.lock || sp.off || sp.cool > 0) return;
  if (!overlapsBox(s.x, s.y, s.r, sp)) return;
  const nx = sp.sa, ny = -sp.ca;             // yerel -y, dünyaya döndürülmüş
  const vn = s.vx * nx + s.vy * ny;
  const tvx = s.vx - nx * vn;
  const tvy = s.vy - ny * vn;
  s.vx = tvx * MOVE.springKeep + nx * MOVE.springSpeed;
  s.vy = tvy * MOVE.springKeep + ny * MOVE.springSpeed;
  // Fırlatma normali boyunca gerçek bir boşlukla ayrıl: beden yüzeyin tamamen
  // dışında kalır, böylece daha sonraki bir alt adım aynı çakışmayı bulamaz
  // ve bir çarpışma kutusuyla tam onun yüzeyinde oturan bir beden arasında
  // titreme olmaz.
  const d = (s.x - sp.x) * nx + (s.y - sp.y) * ny;
  const want = sp.h / 2 + s.r + MOVE.springClear;
  if (d < want) { s.x += nx * (want - d); s.y += ny * (want - d); }
  if (live) { sp.lock = true; sp.cool = MOVE.springCool; }
  RES.spring = sp;
}

/* Ruhun uzaklaştığı her yayı yeniden kur. Simülasyon adımı başına bir kez,
   ruh hareket etmeden ÖNCE çalışır; böylece bir yay, kendi fırlatmasının az
   önce uyguladığı boşluk yüzünden aynı adım içinde hem kilidi açılıp hem de
   ateşlenemez.

   Bu yalnızca TEMAS kilidini açar. Yedek devre dışı bırakma farklı bir
   şeydir ve farklı bir serbest bırakması vardır — springLoop'a bakın — ve
   bir yaydan uzaklaşmak, kontrolün geri verilmiş olmasıyla aynı şey
   değildir. */
function releaseSprings(px, py, r) {
  for (let i = 0; i < world.springs.length; i++) {
    const sp = world.springs[i];
    if (sp.lock && !nearBox(px, py, r, sp, MOVE.springExit)) sp.lock = false;
  }
}

/* Kilidin arkasındaki yedek önlem.

   Bölgeden ayrılmak bir yayı yeniden kurar ve bu doğrudur — ama tam dikine
   nişanlanmış bir yay ruhu bölgesinin çok dışına fırlatır ve onu tam geri
   içine düşürür; bu yüzden bölge kuralı TEK BAŞINA hâlâ bir döngüye izin
   verir: dışarı, geri, dışarı, geri, oyuncu boyunca ölü bir kumanda tutarken.
   Kilit bu durumda kusursuz çalışır ve oyuncu yine de tuzağa düşmüştür.

   Bu yüzden burada gerçekte sayılan şey temaslar ya da saniyeler değil,
   oyuncunun hiç cevap veremediği fırlatmalardır. Bir fazlası ve yay
   tamamen devre dışı bırakılır — `off` — ve ruh onun İÇİNDEN düşer (bir
   yay bir tetikleyicidir, bir yüzey değil) üzerine monte edildiği her ne
   ise onun üzerine iner.

   Devre dışı bırakma yalnızca KONTROLÜN GERİ GELMESİYLE temizlenir, asla
   bir zamanlayıcıyla değil. Bir zamanlayıcı burada asla doğru olamaz: ruhun
   havada ne kadar kalacağına fırlatma karar verir; bu yüzden herhangi bir
   sabit kilitlenme süresi ya güçlü bir yayın döngüsünü kırmaya yetmeyecek
   kadar kısadır ya da zayıf birinde hissedilecek kadar uzundur. Ve
   kontrolün geri gelmesi onu temizlediği için, aynı yaydan bilerek tekrar
   tekrar sekip duran bir oyuncu bunu asla tetiklemez — her fırlatmaya
   cevap veriyordur çünkü. */
const springLoop = {
  sp: null, n: 0,
  /* Oyuncunun söz hakkı oldu. Bundan öncesi sayılmaz ve her devre dışı
     bırakma kaldırılır: ruh her ne içinde sıkışmışsa artık onun içinde
     değildir. */
  clear() {
    this.sp = null; this.n = 0;
    for (let i = 0; i < world.springs.length; i++) world.springs[i].off = false;
  },
  /* bu fırlatma devre dışı bırakılması gereken fırlatmaysa true döner */
  count(sp) {
    if (this.sp === sp) this.n++;
    else { this.sp = sp; this.n = 1; }
    if (this.n < MOVE.springLoopMax) return false;
    this.sp = null; this.n = 0;
    return true;
  },
};

const SUBSTEP_MAX = 10;

/* Bir bedeni hızı kadar ilerlet, yol boyunca karşılaştığı her şeyi çöz.
   Oyuncu ile nişan önizlemesi tarafından birebir aynı şekilde paylaşılır;
   böylece noktalı kılavuz, simülasyonun yapmayacağı bir şeyi asla vadetmez. */
function stepBody(s, live) {
  RES.reset();
  const sp = Math.hypot(s.vx, s.vy);
  const n = Math.min(SUBSTEP_MAX, Math.max(1, Math.ceil(sp / (s.r * 0.42))));
  const solids = world.solids;
  for (let i = 0; i < n; i++) {
    s.x += s.vx / n; s.y += s.vy / n;
    CT.reset();
    for (let k = 0; k < solids.length; k++) collectSolid(s, solids[k]);
    if (CT.n) resolveContactVel(s);

    for (let k = 0; k < world.lethal.length; k++) {
      const e = world.lethal[k];
      if (e.k !== undefined && e.k <= 0.35) continue;
      if (overlapsBox(s.x, s.y, s.r * 0.72, e)) { RES.lethal = e; return RES; }
    }
    // dünya bir boşluk içindeki bir adadır: onu herhangi bir yönde terk etmek
    // ruhu eritir. Sınır payı cömerttir, böylece ucundan kurtulmak asla ucuz
    // bir ölüm olmaz
    if (s.y > world.h + 240 || s.x < -160 || s.x > world.w + 160) {
      RES.lethal = VOID; return RES;
    }

    for (let k = 0; k < world.springs.length; k++) {
      fireSpring(s, world.springs[k], live);
      if (RES.spring) { i = n; break; }
    }
  }
  // Bu bedenin az önce fırladığı bir duvara henüz yeniden tutunulamaz;
  // böylece bir çıkıntının üzerine sıçramak, aynı yüzeyin bir kare sonra
  // seni tekrar yakalamasıyla bozulmaz. Yine de çarpışır — bir duvardır —
  // sadece tutunulamaz. Başka herhangi bir duvara tutunulabilir.
  RES.wallHold = RES.wall && !(s.noWallT > 0 && RES.wallE === s.noWall);
  return RES;
}
const VOID = { kind: 'void' };

/* ---- iniş yardımı ------------------------------------------------------
   Bir çıkıntının hemen kısasında düşmek, başarısızlığın en tatminsiz
   biçimidir: oyuncu durumu doğru okumuştur ve oyun yine de hayır demiştir.
   Bir yüzey tepesinin yüksekliğine yakın düşerken, ruh kaçırmak üzere
   olduğu en yakın kenara doğru nazikçe hızlandırılır.

   Bu bir düzeltme değil, bir ivmedir: oyuncunun zaten sahip olduğu hıza
   göre küçüktür, yalnızca yanal olarak etki eder ve ruh yüzeyin üzerine
   geldiği anda durur. Böylece, karakter senin için hareket ettirilmiş gibi
   görünmeden ucundan kurtulmaları ortadan kaldırır. */
function landingAssist(s) {
  if (s.vy < 1.2) return;                       // yalnızca inerken
  const foot = s.y + s.r;
  let bestDir = 0, bestGap = MOVE.assistReach;
  for (let i = 0; i < world.solids.length; i++) {
    const e = world.solids[i];
    if (e.broken || e.a || e.w < 60) continue;              // yalnızca düz, üzerinde durulabilir tepeler
    const top = e.y - e.h / 2;
    if (foot > top + 12 || foot < top - MOVE.assistBand) continue;
    const gapL = (e.x - e.w / 2) - s.x;         // >0: yüzey sağımızda
    const gapR = s.x - (e.x + e.w / 2);         // >0: yüzey solumuzda
    if (gapL > 0 && gapL < bestGap) { bestGap = gapL; bestDir = 1; }
    else if (gapR > 0 && gapR < bestGap) { bestGap = gapR; bestDir = -1; }
  }
  if (!bestDir) return;
  // Boşluk kapandıkça çekiş güçlenir; bu yüzden ıska en küçük olduğunda en
  // güçlüdür ve bir üst sınırı vardır: ruh çıkıntıya doğru sürüklenebilir,
  // asla ona fırlatılamaz. Bu sınırın ötesinde oyuncu zaten kendi başına o
  // yöne hareket ediyordur ve yardımın ekleyecek bir şeyi yoktur.
  if (s.vx * bestDir >= MOVE.assistMax) return;
  const k = 1 - bestGap / MOVE.assistReach;
  s.vx += bestDir * MOVE.assistPull * k;
}

/* ---- çıkıntı yardımı ----------------------------------------------------
   İniş yardımının eşi; bir çıkıntının üzerine düşmek yerine bir köşenin
   üzerine ÇIKMAK için.

   Var olduğu durum: ruh bir bloğun kenarına tutunuyor ve oyuncu onu
   yukarı, tepesinin üzerine göndermek için çekiyor. O nişanın içe doğru
   bir bileşeni vardır — ve duvar bunu yer, çünkü her karede temas, yüzeyin
   içine doğru işaret eden her hızı kaldırır. Ruh, hiç yanal hız olmadan
   yüzeye sarılarak yükselir ve bloğun yanına dosdoğru geri düşer. Her
   nişan aynı sonuca çöker; bu yüzden "çıkıntının üzerine" oyuncunun ifade
   edebileceği bir şey değildir.

   Bu yüzden o fırlatmanın içe doğru yarısı HATIRLANIR ve ruhun ayakları
   üst kenarı geçip gerçekten o yöne hareket edebildiği anda geri verilir.
   Bu, oyuncunun kendi girdisidir, yalnızca bir an sonra ödenir — onlar
   için icat edilmiş bir düzeltme değildir. Yalnızca bir tutunuştan yukarı
   ve içe nişanlanmış bir fırlatmada devreye girer, yalnızca gerçekten
   erişilebilir bir tepenin yakınında yükselirken öder ve süresi dolar. */
function ledgeAssist(s) {
  if (!s.ledgeDir || s.ledgeT <= 0) return;
  if (s.vy > -0.5) return;                      // yalnızca yükselirken
  const foot = s.y + s.r;
  for (let i = 0; i < world.solids.length; i++) {
    const e = world.solids[i];
    if (e.broken || e.a || e.w < 40) continue;
    const top = e.y - e.h / 2;
    // İçe doğru sürüklenmenin bir anlamı olması için ayakların önce tepeyi
    // geçmesi gerekir: daha erken olursa bu sadece yüzeye tekrar bastırmaktır.
    if (foot > top + 2 || foot < top - MOVE.ledgeBand) continue;
    const gap = s.ledgeDir > 0 ? (e.x - e.w / 2) - s.x : s.x - (e.x + e.w / 2);
    if (gap <= 0 || gap > MOVE.ledgeReach) continue;
    if (s.vx * s.ledgeDir >= MOVE.ledgeMax) return;
    s.vx += s.ledgeDir * MOVE.ledgePull * (1 - gap / MOVE.ledgeReach);
    return;
  }
}

/* Yer çekimi, hava sürtünmesi ve hız tavanı. Sıçrama penceresi birkaç kare
   boyunca yer çekimini askıya alır; böylece bir bırakış, ayrıldığı an
   düşmeye başlayan bir şey yerine bilinçli bir fırlatma gibi okunur. */
function integrate(s) {
  // Canlı uçuş ve yörünge tarafından paylaşılır: akıntılar dinlenen bir
  // bedeni asla etkilemez.
  if (s !== body || PS.state === 'air') for (const w of world.winds) {
    if (Math.abs(s.x-w.x)<w.w/2 && Math.abs(s.y-w.y)<w.h/2) {
      const len = Math.hypot(w.dx,w.dy) || 1;
      s.vx += w.dx/len*w.strength; s.vy += w.dy/len*w.strength;
    }
  }
  if (s.noWallT > 0) s.noWallT = Math.max(0, s.noWallT - STEP);
  if (s.ledgeT > 0) s.ledgeT = Math.max(0, s.ledgeT - STEP);
  if (s.burst > 0) {
    s.burst -= STEP;
  } else {
    const slow = Math.abs(s.vy) < MOVE.floatBand;
    s.vy += MOVE.gravity * (slow ? MOVE.floatScale : 1);
    s.vx *= MOVE.airDrag;
    if (s.vy > MOVE.fallMax) s.vy = MOVE.fallMax;
  }
  const sp = Math.hypot(s.vx, s.vy);
  if (sp > MOVE.speedMax) { const f = MOVE.speedMax / sp; s.vx *= f; s.vy *= f; }
}

/* --- yörünge önizlemesi (aynı entegratör, hiçbir şey iki kez simüle edilmez) --- */
const probe = { x: 0, y: 0, vx: 0, vy: 0, r: MOVE.radius, burst: 0,
  noWall: null, noWallT: 0, ledgeDir: 0, ledgeT: 0 };
const preview = {
  pts: [], n: 0, land: -1, lx: 0, ly: 0,
  landFloor: false,          // üzerinde durulabilecek bir şeyde mi bitti?
  danger: false, spring: false,
};

const MOTION_KEYS = ['x','y','px','py','vx','vy','a','ca','sa','av'];
function predict(x, y, vx, vy, maxDist) {
  // Hareketli yüzeyleri ve ışın fazlarını önceden hesapla, sonra canlı
  // dünyayı geri yükle. Yeniden kullanılan kayıtlar, nişan almayı kare
  // başına anlık görüntü bellek ayırmalarından uzak tutar.
  for (const e of world.movers) {
    if (!e.forecast) e.forecast = {};
    for (const k of MOTION_KEYS) e.forecast[k] = e[k];
  }
  for (const e of world.solids) if (e.crumble) e.forecastBroken = e.broken;
  for (const e of world.beams) e.forecastK = e.k;
  probe.x = x; probe.y = y; probe.vx = vx; probe.vy = vy;
  probe.burst = MOVE.burstTime;
  preview.n = 0; preview.land = -1; preview.landFloor = false;
  preview.danger = false; preview.spring = false;
  let travelled = 0, sinceDot = 1e9;
  for (let i = 0; i < 150; i++) {
    const future = G.t + (i + 1) * STEP;
    updateMotion(future);
    for (const e of world.beams) e.k = beamLevel(e, future);
    for (const e of world.solids) if (e.crumble && e.crumbleT >= 0 && e.crumbleT + (i + 1) * STEP >= e.crumble) e.broken = true;
    const ox = probe.x, oy = probe.y;
    integrate(probe);
    landingAssist(probe);          // kılavuz, oyuncunun aldığı yardımı da içermelidir
    ledgeAssist(probe);
    const r = stepBody(probe);
    if (r.lethal) { preview.danger = true; pushDot(probe.x, probe.y); break; }
    if (r.spring) { preview.spring = true; pushDot(probe.x, probe.y); break; }
    if (r.floor || r.wallHold || r.ceil) {
      preview.land = preview.n;
      preview.landFloor = r.floor || r.wallHold;   // ikisi de kontrolün geri döndüğü yerlerdir
      preview.lx = probe.x; preview.ly = probe.y;
      pushDot(probe.x, probe.y);
      break;
    }
    const moved = Math.hypot(probe.x - ox, probe.y - oy);
    travelled += moved; sinceDot += moved;
    if (sinceDot >= 22) { sinceDot = 0; pushDot(probe.x, probe.y); }
    if (travelled > maxDist) break;
  }
  for (const e of world.movers) for (const k of MOTION_KEYS) e[k] = e.forecast[k];
  for (const e of world.solids) if (e.crumble) e.broken = e.forecastBroken;
  for (const e of world.beams) e.k = e.forecastK;
  return preview;
}
function pushDot(x, y) {
  const i = preview.n++;
  if (!preview.pts[i]) preview.pts[i] = { x: 0, y: 0 };
  preview.pts[i].x = x; preview.pts[i].y = y;
}

/* ============================================================
   7. OYUNCU
   ============================================================
   Yalnızca küçük, adlandırılmış arayüzler üzerinden konuşan dört parça;
   böylece çarpışma döngüsü asla bir görsel alana yazmaz ve çizici asla bir
   fizik alanına yazmaz.

     body  — konum, hız, yarıçap. Entegratörün hareket ettirdiği şey.
     PS    — durum makinesi. Ruhun altı durumdan hangisinde olduğu, orada ne
             kadar süredir olduğu ve oyuncunun şu anda nişan alıp alamayacağı.
     Vis   — kozmetik olan her şey; olaylarla yönetilir (onBurst, onLand, ...).
     Aim   — gerilme: nereye sabitlendiği, ne kadar çekildiği ve bir bırakışın
             bir sıçramaya dönüştüğü tek yer.
   ============================================================ */

const body = { x: 0, y: 0, vx: 0, vy: 0, r: MOVE.radius, burst: 0,
  noWall: null, noWallT: 0,     // az önce ayrıldığımız duvar ve ne kadar süreyle
  ledgeDir: 0, ledgeT: 0 };     // bir tutunuştan yapılan fırlatmadan saklanan içe doğru niyet

/* zeminde · havada · tutunmuş · bir düğüm tarafından tutulmuş · çözülüyor · yeniden şekilleniyor */
const PS = {
  state: 'spawn',
  t: 0,
  prev: 'spawn',
  speed: 0,
  facing: -Math.PI / 2,
  coyote: 0,          // bir yüzeyden ayrıldıktan sonraki hoşgörü
  clingT: 0,          // mevcut tutunuşun ne kadar sürdüğü
  clingWall: null,    // hangi yüzeyin tutulduğu
  clingSide: 0,       // +1 duvar solumuzda, -1 sağımızda
  node: null,         // şu anda bizi tutan düğüm
  fallT: 0,           // ne kadar süredir düştüğümüz (iniş ağırlığı için)
  set(name) {
    if (this.state === name) return;
    this.prev = this.state; this.state = name; this.t = 0;
  },
};

/* Kontrolü geri veren üç durum. Bunun dışındaki her şey taahhüt edilmiş
   harekettir ve ondan çıkmanın tek yolları bir düğüm, bir duvar ya da
   zemindir. */
function canAim() {
  if (G.menu || G.phase !== 'play') return false;
  const s = PS.state;
  return s === 'ground' || s === 'cling' || s === 'node' ||
         (s === 'air' && PS.coyote > 0);
}

/* Şu anda bizi yakalayabilecek en yakın düğüm. Bilerek cömert: bu, oyundaki
   ana mobil hedef ve hareket halinde. */
function nodeInReach() {
  if (PS.state !== 'air' || G.phase !== 'play') return null;
  let best = null, d2best = MOVE.nodeReach * MOVE.nodeReach;
  for (const n of world.nodes) {
    if (n.cool > 0) continue;
    const dx = n.x - body.x, dy = n.y - body.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < d2best) { d2best = d2; best = n; }
  }
  return best;
}

const Vis = {
  squash: 0, squashAng: 0,
  stretch: 0, stretchAng: 0,
  pulse: 0, flash: 0, scale: 1,
  landPop: 0, readyPop: 0, blink: 0, blinkT: 2,
  look: 0, lookT: -Math.PI / 2,      // yaratığın baktığı yön
  trail: [], trailN: 0,

  reset(x, y) {
    this.squash = 0; this.stretch = 0; this.flash = 0; this.scale = 1;
    this.landPop = 0; this.readyPop = 0; this.blink = 0; this.blinkT = 2;
    for (let i = 0; i < TRAIL_N; i++) { this.trail[i].x = x; this.trail[i].y = y; this.trail[i].v = 0; }
    this.trailN = 0;
  },

  step(sp) {
    this.pulse += STEP;
    if (this.flash > 0) this.flash = Math.max(0, this.flash - STEP * 3.4);
    if (this.squash > 0) this.squash = Math.max(0, this.squash - STEP * 3.8);
    if (this.landPop > 0) this.landPop = Math.max(0, this.landPop - STEP * 4.2);
    if (this.readyPop > 0) this.readyPop = Math.max(0, this.readyPop - STEP * 2.8);
    // gerilme sönmek yerine hızı takip eder, bu yüzden hızlı hareket öne yaslanır
    const want = clamp(sp / 20, 0, 1) * 0.3;
    this.stretch += (want - this.stretch) * 0.2;
    if (sp > 0.6) this.stretchAng = PS.facing;
    // yaratık gittiği yöne ya da gitmek üzere olduğu yöne bakar
    const want2 = Aim.on ? Aim.angle : (sp > 1 ? PS.facing : this.lookT);
    let d = ((want2 - this.lookT + Math.PI) % TAU + TAU) % TAU - Math.PI;
    this.lookT += d * 0.22;
    // boşta göz kırpma
    this.blinkT -= STEP;
    if (this.blinkT <= 0) { this.blink = 0.16; this.blinkT = rand(2.4, 5.5); }
    if (this.blink > 0) this.blink = Math.max(0, this.blink - STEP);
  },

  sample(x, y, sp) {
    const tp = this.trail[this.trailN % TRAIL_N];
    tp.x = x; tp.y = y; tp.v = sp;
    this.trailN++;
  },

  onBurst(ang, power) {
    this.squash = 0.5; this.squashAng = ang;
    this.stretch = 0.22 + power * 0.26; this.stretchAng = ang;
    this.flash = 1; this.trailN = 0;
  },
  onLand(hard) {
    this.squash = Math.max(this.squash, 0.24 + hard * 0.46);
    this.squashAng = Math.PI / 2;
    this.landPop = 0.6 + hard * 0.4;
  },
  onWall(nx) {
    this.squash = Math.max(this.squash, 0.3);
    this.squashAng = 0;
    this.stretch *= 0.3;
  },
  onReady() { this.readyPop = 1; },
};
const TRAIL_N = 20;
for (let i = 0; i < TRAIL_N; i++) Vis.trail.push({ x: 0, y: 0, v: 0 });

/* ---- gerilme ---------------------------------------------------------------
   Sapanın durumu. Girdi yalnızca buraya yazar; kılavuz, kamera, karakter
   görselleri ve fırlatma bunu okur ve hiçbiri geri yazmaz.

   `sx/sy` ve `px/py`, dünya birimi değil, SANAL EKRAN birimidir — kameranın
   tutulan bir gerilme altında nişanı bir tüy kadar bile kaydırmadan serbestçe
   hareket edebilmesinin tüm nedeni budur. 10. bölümdeki `toScreen`'e bakın. */
const Aim = {
  on: false,
  from: '',            // gerilmenin hangi durumda başladığı
  sx: 0, sy: 0,        // parmağın nereye bastığı (ekran)
  px: 0, py: 0,        // parmağın şu anda nerede olduğu (ekran)
  pullLen: 0,          // ekran biriminde ham gerilme uzunluğu
  pull: 0,             // kullanılabilir gerilmenin 0..1 arası
  power: 0,            // powerCurve ile şekillendirilmiş çekiş; oyunun tepki verdiği şey
  angle: 0,            // fırlatma yönü: çekişin aynadaki yansıması
  held: 0,
  clear() {
    this.on = false; this.power = 0; this.pull = 0; this.pullLen = 0; this.held = 0;
  },
};

/* Bir duvardan ayrılmak.

   Güvenlik itişi tam olarak tek bir nedenle var: bir yüzey boyunca düz
   nişanlanmış bir sıçrama, aksi halde doğrudan onun içine sürtünerek geri
   dönerdi. Oyuncunun nereye gideceğine karar vermek için orada DEĞİLDİR,
   ama eskiden öyleydi: tuttuğun bloğun tepesinin üzerine yukarı doğru
   nişan almak, yanal bileşeni ters çevrilmiş bir hız üretiyordu — sol-yukarı
   çek, sağ-yukarı git — bu da oyundaki en doğal hareketi, bir duvardan
   üzerindeki çıkıntıya sıçramayı, imkânsız kılıyordu.

   Bu yüzden itiş artık nişanın ne kadar yukarı baktığına göre söner. Düz
   bir nişan yine de temizlenir; `clingFree`'den daha dik bir nişan, içe
   doğru olsun ya da olmasın, tamamen olduğu gibi alınır, çünkü yukarı
   doğru bir nişan oyuncunun tepenin üzerinden gitmesidir ve bunun nereye
   vardığını tam olarak görebilirler. Sönme yumuşaktır, bu yüzden kontrolün
   aniden davranış değiştirdiği bir açı yoktur. */
function applyClingKick(ang, sp, out) {
  const nx = PS.clingSide;                 // +1 = duvar solumuzda, sağa it
  const raw = Math.cos(ang) * sp;
  const vy = Math.sin(ang) * sp;
  const up = -Math.sin(ang);               // -1 dümdüz aşağı .. +1 dümdüz yukarı
  const bite = 1 - smoothstep(clamp(up / MOVE.clingFree, 0, 1));
  let vx = raw;
  if (bite > 0) {
    const want = lerp(MOVE.clingKick * sp, MOVE.clingKickMin, clamp(up, 0, 1));
    const outward = raw * nx;
    if (outward < want) vx = lerp(raw, raw + nx * (want - outward), bite);
  }
  out.x = vx; out.y = vy;
  return out;
}
const KICK = { x: 0, y: 0 };

/* Bu fırlatma, tutulan şeyin tepesinin üzerine yukarı doğru nişanlanmışsa,
   çıkıntı yardımını devreye sok. Gerçek fırlatma ile önizleme tarafından
   paylaşılır; böylece noktalı kılavuz oyuncunun uçacağı aynı yayı gösterir. */
function armLedgeAssist(s, ang, sp) {
  s.ledgeDir = 0; s.ledgeT = 0;
  const up = -Math.sin(ang);
  if (up < MOVE.clingFree) return;                 // yukarı doğru bir nişan değil
  const inward = -PS.clingSide;                    // tuttuğumuz yüzeyden uzağa
  if (Math.cos(ang) * inward <= 0) return;         // tepenin üzerine nişanlanmamış
  s.ledgeDir = inward;
  s.ledgeT = MOVE.ledgeTime;
}

/* Bir gerilmenin harekete dönüştüğü tek yer. */
function doBurst(ang, power) {
  const fromNode = PS.state === 'node' && PS.node;
  const p = clamp(power, 0, 1);
  const sp = launchSpeed(p, fromNode);
  let vx = Math.cos(ang) * sp, vy = Math.sin(ang) * sp;

  if (PS.state === 'cling') {
    const k = applyClingKick(ang, sp, KICK);
    vx = k.x; vy = k.y;
    // ayrıldığımız yüzey bizi bir süreliğine tekrar yakalayamaz
    body.noWall = PS.clingWall; body.noWallT = MOVE.wallRegrab;
    armLedgeAssist(body, ang, sp);
  }
  PS.support = null;
  body.vx = vx; body.vy = vy;
  body.burst = MOVE.burstTime;
  PS.facing = Math.atan2(vy, vx);
  PS.coyote = 0; PS.clingT = 0;

  const hue = fromNode ? HUE.node : HUE.spirit;
  if (fromNode) {
    const n = PS.node;
    n.cool = MOVE.nodeCool;
    n.glow = 1;
    FX.shock(n.x, n.y, n.r, n.r + 70, 0.4, HUE.node.rgb, 3);
    FX.spark(n.x, n.y, ang, 0.5, 4 + p * 4, 9, HUE.node.rgb,
             { life: 0.45, size: 2.6, shape: 1, len: 12, drag: 0.9 });
    Sfx.nodeFire(p);
    PS.node = null;
  } else {
    Sfx.burst(p);
  }
  PS.set('air');
  Vis.onBurst(ang, p);
  FX.spark(body.x - Math.cos(ang) * 10, body.y - Math.sin(ang) * 10, ang + Math.PI,
           0.55, 3 + p * 4, 7, hue.rgb, { life: 0.4, size: 2.4, shape: 1, len: 11, drag: 0.9 });
  FX.shock(body.x, body.y, body.r, body.r + 28 + p * 26, 0.32, hue.rgb, 3);
  cam.shake = Math.max(cam.shake, 1.4 + p * 3);
  cam.kx -= Math.cos(ang) * (1 + p * 2);
  cam.ky -= Math.sin(ang) * (1 + p * 2);
  // Testler ve istatistikler için tutulur, hiçbir yerde gösterilmez.
  G.bursts++;
  G.totalBursts++;
  setHint('');
}

/* ============================================================
   8. OYUN DURUMU
   ============================================================ */

/* ---- depolama ---------------------------------------------------------------
   localStorage'ın var olacağı ya da çalışacağı garanti değildir: bazı
   gömülü webview'lerde bulunmaz, sıkı bir gizlilik ayarı altında erişimde
   hata fırlatır ve kota dolduğunda setItem hata fırlatır. Bunların hiçbiri
   oyuncunun sorunu değildir; bu yüzden her çağrı buradan geçer ve bir
   başarısızlık yalnızca kalıcı olmayan bir oturum demektir. Bir yazma
   başarısız olduktan sonra denemeyi bırakırız. */
const Store = {
  ok: true,
  get(key) {
    if (!this.ok) return null;
    try { return localStorage.getItem(GAME.storageKey + '.' + key); }
    catch (err) { this.ok = false; return null; }
  },
  set(key, value) {
    if (!this.ok) return false;
    try { localStorage.setItem(GAME.storageKey + '.' + key, value); return true; }
    catch (err) { this.ok = false; return false; }
  },
  del(key) {
    try { localStorage.removeItem(GAME.storageKey + '.' + key); } catch (err) {}
  },
};

/* ---- ilerleme ----------------------------------------------------------------
   Oturumlar arasında saklamaya değer tek şey, oyuncunun ne kadar ilerlediğidir.

   Bilerek KAYDEDİLMEYENLER: konum, hız, durum, hangi kontrol noktasının
   alındığı — oyunu, oyuncunun çıkamayacağı bir duruma geri getirebilecek
   her şey. Bir bölümü yeniden başlatmak onu her zaman bölüm verisinden
   yeniden kurar; bu yüzden bir kayıt, bir bölümün kazanılamaz olmasının
   nedeni asla olamaz.

   `unlocked`, başlatılabilecek en uzak bölümdür, `done` ise hangilerinin
   tamamlandığıdır. İkisi de gerçekten var olan bölümlere göre sınırlanır;
   bu yüzden oyunun şu andakinden daha fazla bölümü olduğu zaman yazılmış
   bir kayıt hâlâ yüklenir. */
const SAVE_V = 1;

const Save = {
  data: { v: SAVE_V, unlocked: 0, done: [] },
  fresh() { return { v: SAVE_V, unlocked: 0, done: [] }; },
  load() {
    this.data = this.fresh();
    const raw = Store.get('progress');
    if (!raw) return this.data;
    try {
      const o = JSON.parse(raw);
      // tanımadığımız her şey güvenilmek yerine atılır: kötü bir kayıt en
      // kötü ihtimalle oyuncuya ilerlemesine mal olmalıdır, asla oyuna değil
      if (o && o.v === SAVE_V) {
        this.data.unlocked = clamp(o.unlocked | 0, 0, LEVELS.length - 1);
        if (Array.isArray(o.done)) {
          this.data.done = o.done.filter(
            (i) => Number.isInteger(i) && i >= 0 && i < LEVELS.length);
          // Eski altı bölümlük oyunu bitirmiş bir kayıt, şimdi yedinci bölümü açar.
          for (const i of this.data.done) this.data.unlocked = Math.max(this.data.unlocked, Math.min(i + 1, LEVELS.length - 1));
        }
      }
    } catch (err) { /* bozuk ya da yabancı: temiz başla ve oynamaya devam et */ }
    return this.data;
  },
  write() { return Store.set('progress', JSON.stringify(this.data)); },
  /* oyuncunun başlayabileceği en uzak bölüm — her zaman gerçek bir indeks */
  unlocked() { return clamp(this.data.unlocked, 0, LEVELS.length - 1); },
  completed(i) { return this.data.done.indexOf(i) >= 0; },
  /* Bir bölümü bitirmek bir sonrakini açar. İşaret asla geriye gitmez; bu
     yüzden erken bir bölümü yeniden oynamak, oyuncunun yaptıklarına mal
     olamaz. */
  complete(i) {
    if (i < 0 || i >= LEVELS.length) return;
    if (!this.completed(i)) this.data.done.push(i);
    const next = clamp(i + 1, 0, LEVELS.length - 1);
    if (next > this.data.unlocked) this.data.unlocked = next;
    this.write();
  },
  reset() { this.data = this.fresh(); Store.del('progress'); },
};

const G = {
  phase: 'play',          // play | win | trans | done
  t: 0,
  phaseT: 0,
  levelIndex: 0,
  level: null,
  bursts: 0,
  totalBursts: 0,       // koşu toplamı, bölümler ve tekrar denemeler boyunca — yalnızca dahili
  runTime: 0,
  spawnX: 0, spawnY: 0,   // son alınan kontrol noktası ya da bölüm başlangıcı
  deaths: 0,
  transDir: 0, transT: 0, transDur: 0.42, transNext: null,
  fadeIn: 0,
  deny: 0,
};

const cam = {
  x: 0, y: 0, tx: 0, ty: 0,
  mode: 'rest', settleT: 0,
  shake: 0, sx: 0, sy: 0,
  kx: 0, ky: 0,           // bir fırlatma ya da çarpmadan gelen yönlü itki
  zoom: 1, tzoom: 1, punch: 0,
  flash: 0, flashCol: [255, 255, 255],
};

/* ---- DOM ---- */
const dom = {
  canvas: document.getElementById('game'),
  levelNum: document.getElementById('levelNum'),
  levelName: document.getElementById('levelName'),
  levelTot: document.getElementById('levelTot'),
  progress: document.getElementById('progressFill'),
  restart: document.getElementById('restartBtn'),
  banner: document.getElementById('banner'),
  bannerNum: document.querySelector('.banner-num'),
  bannerName: document.querySelector('.banner-name'),
  hint: document.getElementById('hint'),
  toast: document.getElementById('toast'),
  endCard: document.getElementById('endCard'),
  endRestart: document.getElementById('endRestart'),
  endTime: document.getElementById('endTime'),
  endLevels: document.getElementById('endLevels'),
  fps: document.getElementById('fps'),
  sound: document.getElementById('soundBtn'),
};
const ctx = dom.canvas.getContext('2d');

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

/* Tüm HUD, tek bir yerde.

   Bir sıçrama sayacı yoktur: oyunda hiçbir şey sıçramalarla kısıtlanmaz; bu
   yüzden bu rakam oyuncuya harekete geçebileceği hiçbir şey söylemezdi.
   Sayı yine de testler ve istatistikler için `G` üzerinde tutulur — sadece
   gösterilmez.

   Toplam, her yazıldığında LEVELS.length'ten gelir; bu yüzden bir bölüm
   eklemek, başka hiçbir şeyi hatırlamaya gerek kalmadan bir bölüm eklemek
   demektir. */
function updateHud() {
  const i = G.levelIndex;
  dom.levelNum.textContent = pad2(i + 1);
  dom.levelTot.textContent = pad2(LEVELS.length);
  dom.levelName.textContent = LEVELS[i].name;
  dom.progress.style.width = ((i + 1) / LEVELS.length * 100) + '%';
}

/* Açılışta tek bir geçiş, adı ve her sabit etiketi sayfaya yazar. İşaretleme
   bunların hiçbiriyle birlikte gelmez; bu yüzden eski bir başlığın ya da
   çevrilmemiş bir etiketin saklanabileceği hiçbir yer yoktur. */
function applyBranding() {
  const el = (id) => document.getElementById(id);
  const setText = (id, v) => { const n = el(id); if (n) n.textContent = v; };
  const setAttr = (id, k, v) => { const n = el(id); if (n && n.setAttribute) n.setAttribute(k, v); };

  document.title = GAME.title;
  setText('markName', GAME.title);
  setText('menuTitle', GAME.title);
  setText('menuTagline', TEXT.tagline);
  setText('endTitle', GAME.title);
  setAttr('game', 'aria-label', GAME.title + ' ' + TEXT.canvasLabel);

  setText('markSub', TEXT.tagline);
  setText('markKeys', TEXT.controls);
  setText('hudLevelKey', TEXT.hudLevel);
  setText('endSub', TEXT.endSub);
  setText('endTimeLabel', TEXT.endTime);
  setText('endLevelLabel', TEXT.endLevels);
  setText('endRestart', TEXT.replay);
  setAttr('soundBtn', 'aria-label', TEXT.sound);
  setAttr('restartBtn', 'aria-label', TEXT.restart);

  const root = document.documentElement;
  if (root && root.setAttribute) root.setAttribute('lang', GAME.lang);
  const meta = document.querySelector && document.querySelector('meta[name="description"]');
  if (meta && meta.setAttribute) meta.setAttribute('content', TEXT.description);
}
function showBanner(i) {
  const L = LEVELS[i];
  dom.bannerNum.textContent = pad2(i + 1);
  dom.bannerName.textContent = L.name;
  dom.banner.classList.remove('show');
  void dom.banner.offsetWidth;
  dom.banner.classList.add('show');
}
function showToast(msg, opts) {
  const o = opts || {};
  dom.toast.textContent = msg;
  dom.toast.classList.remove('hidden', 'show', 'quick', 'info');
  void dom.toast.offsetWidth;
  dom.toast.classList.add('show');
  if (o.quick) dom.toast.classList.add('quick');
  if (o.info) dom.toast.classList.add('info');
}
function setHint(text) {
  if (text) { dom.hint.textContent = text; dom.hint.classList.remove('hidden'); }
  else dom.hint.classList.add('hidden');
}

/* Ruhu bir noktaya bırak, tamamen sıfırla ve yeniden şekillenmesine izin ver. */
function placeSpirit(x, y) {
  PS.support = null;
  body.x = x; body.y = y; body.vx = 0; body.vy = 0; body.burst = 0;
  PS.state = 'spawn'; PS.t = 0; PS.prev = 'spawn';
  PS.coyote = 0; PS.clingT = 0; PS.clingSide = 0; PS.node = null;
  PS.speed = 0; PS.facing = -Math.PI / 2; PS.fallT = 0;
  Aim.clear();
  clearBuffer();
  springLoop.clear();
  Vis.reset(x, y);
}

function startLevel(i) {
  G.menu = false;
  document.getElementById('ui').inert = false;
  dom.endCard.inert = false;
  document.getElementById('menuCard').classList.add('hidden');
  dom.endCard.classList.add('hidden');
  G.levelIndex = i;
  G.level = buildWorld(LEVELS[i]);
  G.bursts = 0;
  G.t = 0;
  G.phase = 'play'; G.phaseT = 0;
  G.fadeIn = 0.5;
  G.spawnX = LEVELS[i].spawn.x; G.spawnY = LEVELS[i].spawn.y;
  clearFX();
  placeSpirit(G.spawnX, G.spawnY);
  updateCamera(true);
  updateHud();
  showBanner(i);
  setHint('');
  setTimeout(() => {
    if (G.levelIndex === i && G.bursts === 0 && G.phase === 'play') setHint(LEVELS[i].tip);
  }, 1150);
}

function transitionTo(fn) {
  G.phase = 'trans'; G.transDir = 1; G.transT = 0; G.transNext = fn;
  Sfx.sweep();
}
function nextLevel() {
  const n = G.levelIndex + 1;
  transitionTo(n >= LEVELS.length ? finishRun : () => startLevel(n));
}
function finishRun() {
  G.phase = 'done';
  const secs = Math.round(G.runTime);
  dom.endTime.textContent = Math.floor(secs / 60) + ':' + pad2(secs % 60);
  dom.endLevels.textContent = LEVELS.length + ' / ' + LEVELS.length;
  dom.endCard.classList.remove('hidden');
  Sfx.complete();
  G.level = buildWorld(LEVELS[LEVELS.length - 1]);
  placeSpirit(LEVELS[LEVELS.length - 1].spawn.x, LEVELS[LEVELS.length - 1].spawn.y);
  updateCamera(true);
}
function restartRun() {
  doneFrames = 0;
  dom.endCard.classList.add('hidden');
  G.totalBursts = 0; G.runTime = 0; G.deaths = 0;
  startLevel(0);
}
function restartLevel(silent) {
  if (G.menu || G.phase === 'done' || G.transDir !== 0) return;
  if (!silent) Sfx.ui();
  startLevel(G.levelIndex);
  G.fadeIn = 0.3;
}

/* ---- başarısızlık: hızlı, ucuz ve her zaman son kontrol noktasına geri döner ---- */
function killSpirit(kind) {
  if (PS.state === 'hurt' || PS.state === 'spawn' || G.phase !== 'play') return;
  PS.set('hurt');
  G.deaths++;
  Aim.clear(); clearBuffer();
  Sfx.tensionStop();
  const c = HUE.spirit;
  if (kind === 'void') {
    FX.spark(body.x, body.y, -Math.PI / 2, Math.PI, 2.4, 8, c.rgb, { life: 0.5, size: 2.2, drag: 0.92 });
    cam.shake = Math.max(cam.shake, 3);
  } else {
    FX.spark(body.x, body.y, 0, Math.PI, 5.5, 12, DANGER, { life: 0.42, size: 2.8, drag: 0.93, shape: 1, len: 9 });
    FX.spark(body.x, body.y, 0, Math.PI, 3, 6, c.rgb, { life: 0.4, size: 2.2, drag: 0.93 });
    FX.shock(body.x, body.y, 4, 76, 0.36, DANGER, 4);
    cam.shake = Math.max(cam.shake, 9);
    cam.flash = Math.max(cam.flash, 0.3); cam.flashCol = DANGER;
  }
  Sfx.fail();
}

function respawn() {
  for (const e of world.solids) { e.crumbleT = -1; e.broken = false; }
  placeSpirit(G.spawnX, G.spawnY);
  G.fadeIn = 0.12;
  FX.implode(G.spawnX, G.spawnY, 54, 9, HUE.spirit.hi, 0.34);
  Sfx.respawn();
  updateCamera(true);
}

function reachGate() {
  G.phase = 'win'; G.phaseT = 0;
  G.goalBurst = false;
  // geçişte değil burada kaydedilir; böylece bir bölüm gerçekten bittiği
  // anda sayılır ve geçiş sırasında bir yenileme onu kaybedemez
  Save.complete(G.levelIndex);
  const g = world.gate;
  FX.implode(g.x, g.y, 92, 11, HUE.gate.hi, 0.5);
  FX.shock(g.x, g.y, g.r, g.r + 130, 0.7, HUE.gate.rgb, 4);
  cam.punch = 0.05; cam.flash = 0.3; cam.flashCol = HUE.gate.hi;
  Aim.clear(); clearBuffer();
  Sfx.gate(); Sfx.tensionStop();
  setHint('');
}

/* ---- süpürülen tetikleyiciler: kontrol noktaları ve geçit, tüm adım boyunca kontrol edilir ---- */
function checkTriggers(px, py) {
  const dx = body.x - px, dy = body.y - py;
  const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 8));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const sx = px + dx * t, sy = py + dy * t;
    for (const m of world.motes) {
      if (m.got) continue;
      if (Math.hypot(sx - m.x, sy - m.y) < m.r + body.r) {
        m.got = true; m.pop = 1;
        G.spawnX = m.x; G.spawnY = m.y - 26;
        FX.shock(m.x, m.y, m.r * 0.6, m.r + 64, 0.5, HUE.mote.rgb, 3);
        FX.spark(m.x, m.y, 0, Math.PI, 2.6, 8, HUE.mote.hi, { life: 0.5, size: 2.2, drag: 0.92 });
        cam.flash = Math.max(cam.flash, 0.12); cam.flashCol = HUE.mote.hi;
        Sfx.mote();
      }
    }
    const g = world.gate;
    // tetikleyici, gördüğün halkaya artı bedenin biraz fazlasına uyar:
    // görünür şekilde dokunduğun bir geçit her zaman sayılmalıdır
    if (Math.hypot(sx - g.x, sy - g.y) < g.r + body.r * 0.5) { body.x = sx; body.y = sy; reachGate(); return; }
  }
}

/* ---- sabit bir simülasyon adımı ---- */
function simStep() {
  if (G.menu) return;
  // Bir gerilme dünyayı dondurur. Bir telefonda bu, kullanabileceğin bir
  // mekanikle beceriksizce elinden kaçırdığın bir mekanik arasındaki farktır
  // ve hiçbir maliyeti yoktur: ruh, buna izin verildiğinde zaten zemin, bir
  // duvar ya da bir düğüm tarafından tutulmaktadır.
  if (Aim.on) {
    Aim.held += STEP;
    refreshAimPreview();
    if (PS.state === 'node' && PS.node) {
      body.x = lerp(body.x, PS.node.x, MOVE.nodePull);
      body.y = lerp(body.y, PS.node.y, MOVE.nodePull);
    }
    Vis.step(PS.speed);
    // bu bir gün tetiklenirse kayıp bir işaretçi demektir; bu yüzden sessiz
    // kalmak yerine bunu belirt: hiçbir işaret vermeden yanıt vermeyi
    // bırakan bir kontrol, ne olduğu hakkında hiçbir fikri olmayan oyuncu
    // tarafından düzeltilemez
    if (Aim.held >= MOVE.aimHold) { cancelAim(); G.deny = 1; }
    updateCamera(false);
    return;
  }

  G.t += STEP;
  if (G.phase !== 'done') G.runTime += STEP;
  G.phaseT += STEP;

  updateMotion(G.t);
  if (PS.state === 'ground' && PS.support && !PS.support.broken) {
    body.x += PS.support.vx; body.y += PS.support.vy;
    // Öteleme tam olarak bir kez uygulanır. Temas hızı göreceli kalır.
    body.vy = 0;
  }
  for (const e of world.solids) if (e.crumble && e.crumbleT >= 0 && !e.broken) {
    e.crumbleT += STEP;
    if (e.crumbleT >= e.crumble) {
      e.broken = true;
      FX.spark(e.x,e.y,-Math.PI/2,Math.PI,2.5,8,HUE.stone.rgb,{life:.5,size:3,grav:.15});
      Sfx.crack();
      if (PS.support === e) { PS.support = null; PS.set('air'); PS.coyote = MOVE.coyote; }
    }
  }
  Sfx.environment(G.phase === 'play' ? world.winds.some(w => Math.abs(body.x-w.x)<w.w/2+100 && Math.abs(body.y-w.y)<w.h/2+100) : false);
  for (const b of world.beams) b.k = beamLevel(b, G.t);
  for (const n of world.nodes) {
    if (n.cool > 0) n.cool = Math.max(0, n.cool - STEP);
    if (n.glow > 0) n.glow = Math.max(0, n.glow - STEP * 2);
    n.spin += STEP * (n.cool > 0 ? 0.6 : 1.8);
  }
  for (const s of world.springs) {
    if (s.fire > 0) s.fire = Math.max(0, s.fire - STEP * 2.6);
    if (s.cool > 0) s.cool = Math.max(0, s.cool - STEP);
  }
  releaseSprings(body.x, body.y, body.r);
  for (const m of world.motes) if (m.pop > 0) m.pop = Math.max(0, m.pop - STEP * 2);
  if (world.gate.open > 0 && G.phase !== 'win') world.gate.open = Math.max(0, world.gate.open - STEP * 2);

  updateDust();
  updateParticles();

  cam.shake *= 0.86;
  if (cam.shake < 0.05) cam.shake = 0;
  cam.sx = rand(-1, 1) * cam.shake;
  cam.sy = rand(-1, 1) * cam.shake;
  cam.kx *= 0.82; cam.ky *= 0.82;
  if (Math.abs(cam.kx) < 0.02) cam.kx = 0;
  if (Math.abs(cam.ky) < 0.02) cam.ky = 0;
  cam.punch *= 0.90;
  if (Math.abs(cam.punch) < 0.002) cam.punch = 0;
  cam.flash *= 0.8;
  if (G.fadeIn > 0) G.fadeIn = Math.max(0, G.fadeIn - STEP);
  if (G.deny > 0) G.deny = Math.max(0, G.deny - STEP * 2.4);

  PS.t += STEP;

  if (G.phase === 'play') updateSpirit();
  else if (G.phase === 'win') {
    const g = world.gate;
    if (!G.goalBurst && G.phaseT > .34) {
      G.goalBurst = true;
      const finale = G.levelIndex === LEVELS.length - 1;
      FX.spark(g.x,g.y,0,Math.PI,finale?6:4,finale?22:12,HUE.gate.hi,{life:.65,size:2.6,drag:.94});
      FX.shock(g.x,g.y,20,finale?210:140,.55,HUE.gate.rgb,3);
    }
    g.open = Math.min(1, g.open + STEP * 3);
    body.x = lerp(body.x, g.x, 0.2); body.y = lerp(body.y, g.y, 0.2);
    body.vx *= 0.8; body.vy *= 0.8;
    Vis.scale = Math.max(0, 1 - easeIn(clamp(G.phaseT / 0.45, 0, 1)));
    if (G.phaseT > 0.95) nextLevel();
  }

  Vis.step(PS.speed);
  updateCamera(false);

  if (G.transDir !== 0) {
    G.transT += STEP;
    if (G.transT >= G.transDur) {
      if (G.transDir === 1) {
        const fn = G.transNext; G.transNext = null;
        G.transDir = -1; G.transT = 0;
        if (fn) fn();
      } else { G.transDir = 0; G.transT = 0; }
    }
  }
}

/* Oyuncunun fiziksel yaşamının tamamı, gerçekleştiği sırayla. */
function updateSpirit() {
  if (PS.state === 'hurt') {
    Vis.scale = Math.max(0, Vis.scale - STEP * 4);
    body.x += body.vx * 0.2; body.y += body.vy * 0.2;
    body.vx *= 0.9; body.vy *= 0.9;
    if (PS.t >= MOVE.hurtTime) respawn();
    return;
  }
  if (PS.state === 'spawn') {
    Vis.scale = Math.min(1, Vis.scale + STEP / MOVE.respawnTime);
    if (PS.t >= MOVE.respawnTime) { PS.set('air'); PS.coyote = MOVE.coyote; }
    return;
  }
  if (PS.state === 'node') return;         // tutulmuş; yalnızca bir bırakış bizi hareket ettirir

  const wasAimable = canAim();
  const px = body.x, py = body.y;
  const fallSpeed = body.vy;

  // Bir tutunuş askıya alınmış bir düşüş değildir: ruh duvarı tuttuğu
  // sürece kendi hızına tamamen sahiptir ve yer çekimi basitçe uygulanmaz.
  // Yer çekiminin bir tutunuş altında birikmesine izin vermek, kavramanın
  // her karede biraz aşağı sürünmesine yol açıyordu; bu da karakterin sağlam
  // durması gerekirken kayıyormuş gibi okunuyordu.
  if (PS.state === 'cling') {
    PS.clingT += STEP;
    if (PS.clingT >= MOVE.clingTime) {
      PS.set('air'); PS.coyote = MOVE.coyote;
      integrate(body);
    } else {
      body.vy = PS.clingT < MOVE.clingGrip ? 0 : MOVE.clingSlide;
      body.vx = -PS.clingSide * 0.7;       // yüzeye bastırılmış olarak kal
      if (PS.clingT > MOVE.clingGrip && ((PS.clingT * 60) | 0) % 7 === 0) {
        FX.spark(body.x - PS.clingSide * body.r, body.y, Math.PI / 2, 0.5, 0.9, 1,
                 HUE.spirit.rgb, { life: 0.3, size: 1.5, drag: 0.9 });
      }
    }
  } else {
    integrate(body);
    landingAssist(body);
    ledgeAssist(body);
  }

  const r = stepBody(body, true);

  if (r.lethal) { killSpirit(r.lethal.kind === 'void' ? 'void' : 'hazard'); return; }

  if (r.spring) {
    const s = r.spring;
    // Temas başına tam olarak bir fırlatma olayı: yay ateşlenirken kendini
    // kilitledi; bu yüzden aşağıdaki her şey — ses, şok dalgası, sarsıntı —
    // bir kez olur ve ruh hâlâ üzerindeyken yeniden tetiklenemez.
    if (springLoop.count(s)) s.off = true;
    s.fire = 1;
    PS.set('air');
    body.burst = MOVE.burstTime * 0.7;
    PS.facing = Math.atan2(body.vy, body.vx);
    Vis.onBurst(PS.facing, 1);
    FX.shock(s.x, s.y, 10, 92, 0.45, HUE.spring.rgb, 4);
    FX.spark(s.x, s.y, PS.facing, 0.6, 5.5, 10, HUE.spring.hi,
             { life: 0.5, size: 2.8, shape: 1, len: 13, drag: 0.92 });
    cam.shake = Math.max(cam.shake, 6);
    cam.flash = Math.max(cam.flash, 0.16); cam.flashCol = HUE.spring.hi;
    Sfx.spring();
  } else if (r.floor) {
    PS.support = r.floorE;
    if (PS.support && PS.support.crumble && PS.support.crumbleT < 0) {
      PS.support.crumbleT = 0; Sfx.crack();
    }
    // üzerinde durulabilecek bir şeye varmak
    if (PS.state !== 'ground') {
      const hard = clamp(fallSpeed / MOVE.landHard, 0, 1);
      Vis.onLand(hard);
      FX.spark(body.x, body.y + body.r * 0.7, -Math.PI / 2, 1.5, 1 + hard * 3.2,
               2 + (hard * 5 | 0), HUE.spirit.rgb, { life: 0.34, size: 2, drag: 0.88, grav: 0.12 });
      if (hard > 0.4) {
        FX.shock(body.x, body.y + body.r * 0.6, 6, 22 + hard * 40, 0.3, HUE.spirit.rgb, 2);
        cam.shake = Math.max(cam.shake, hard * 4.5);
      }
      Sfx.land(hard);
      PS.set('ground');
    }
    body.ledgeDir = 0; body.ledgeT = 0;
    PS.coyote = MOVE.coyote;
    PS.clingT = 0;
    if (PS.support && PS.support.motion) body.vy = 0;
    body.vx *= MOVE.groundDrag;
    if (Math.abs(body.vx) < MOVE.groundStop) body.vx = 0;
  } else if (r.wallHold) {
    // bir duvara ilk kez tutunmak; tutunuşun kendisi yukarıda yürütülür
    if (PS.state !== 'cling') {
      PS.set('cling');
      PS.clingT = 0;
      PS.clingSide = RES.wallNx < 0 ? -1 : 1;
      PS.clingWall = RES.wallE;
      body.vx = 0; body.vy = 0;
      Vis.onWall(RES.wallNx);
      FX.spark(RES.hx, RES.hy, Math.atan2(RES.ny, RES.nx), 1.1, 2.4, 4, HUE.spirit.rgb,
               { life: 0.34, size: 1.9, drag: 0.9 });
      cam.shake = Math.max(cam.shake, 1.6);
      Sfx.cling();
    }
  } else {
    if (PS.state === 'ground' || PS.state === 'cling') { PS.set('air'); PS.coyote = MOVE.coyote; }
    if (PS.state === 'air') PS.coyote = Math.max(0, PS.coyote - STEP);
    if (r.ceil) body.vy = Math.max(body.vy, 0.4);
  }

  PS.speed = Math.hypot(body.vx, body.vy);
  if (PS.speed > 0.8) PS.facing = Math.atan2(body.vy, body.vx);
  PS.fallT = PS.state === 'air' ? PS.fallT + STEP : 0;

  checkTriggers(px, py);
  if (G.phase !== 'play') return;

  Vis.sample(body.x, body.y, PS.speed);
  if (!wasAimable && canAim()) { Vis.onReady(); springLoop.clear(); }
  updateAimBuffer();
}

/* ---- kamera ----------------------------------------------------------------
   Kamerayı tek bir sistem yönetir ve dört modu vardır:

     DİNLENME  ayakta ya da tutunmuş, hiçbir şey olmuyor. Normal kadraj.
     NİŞAN     bir gerilme tutuluyor. FIRLATMA yönüne doğru öne geç — parmak
               ruhun arkasında, bilgi ise önünde — ve ilerideki dünyanın
               daha fazlası görünsün diye yavaşlayarak uzaklaş.
     SEYAHAT   havada. Hafif bir öngörüyle takip et.
     YERLEŞME  az önce vardı. Normal kadraja yavaşça geri dön.

   Kameranın yaptığı her şey burada ve yalnızca burada kararlaştırılır. Hedef
   ile çizilen değer ayrı tutulur — oyun mantığı `cam.tx/ty/tzoom`'a yazar ve
   tam olarak tek bir yumuşatma adımı `cam.x/y/zoom`'u onlara doğru
   hareket ettirir — böylece iki sistem aynı karede yakınlaştırmayı farklı
   yönlere çekemez.

   En önemlisi, buradaki hiçbir şey nişana geri beslenmez. Nişan ekran
   uzayında ölçülür (10. bölüme bakın) ve kameranın nerede olduğundan ya da
   ne kadar yakınlaştığından etkilenemez; görünümün, tutulan bir gerilme
   kusursuzca hareketsiz kalırken hareket edebilmesini sağlayan da budur. */
const CAM_PAD = 95;   // görünümün dünya kenarının ne kadar ötesine sürüklenebileceği

function cameraMode() {
  if (Aim.on && Aim.pullLen > MOVE.dragDead) return 'aim';
  if (PS.state === 'air' || PS.speed > MOVE.camTravelSpeed) return 'travel';
  return cam.settleT > 0 ? 'settle' : 'rest';
}

function updateCamera(snap) {
  const mode = cameraMode();
  if (mode !== cam.mode) {
    // hareket eden bir moddan ayrılmak yerleşmeyi başlatır; böylece normal
    // kadraja dönüş bir sıçrama değil, bilinçli bir yavaşlama olur
    if ((cam.mode === 'aim' || cam.mode === 'travel') && mode !== 'aim' && mode !== 'travel') {
      cam.settleT = MOVE.camSettle;
    }
    cam.mode = mode;
  }
  if (cam.settleT > 0) cam.settleT = Math.max(0, cam.settleT - STEP);

  let tx = body.x, ty = body.y, zoom = 1, ease = MOVE.camEase;

  if (mode === 'aim') {
    // fırlatma vektörü boyunca öne geç: ruhun gerçekten gideceği yön,
    // parmağın çekildiği yönün tam tersidir
    const lead = lerp(MOVE.camLeadMin, MOVE.camLead, Aim.power);
    tx += Math.cos(Aim.angle) * lead;
    ty += Math.sin(Aim.angle) * lead;
    zoom = lerp(1, MOVE.zoomAim, Aim.power);
    ease = MOVE.camEaseAim;
  } else if (mode === 'travel') {
    tx += clamp(body.vx * MOVE.camFollow, -200, 200);
    ty += clamp(body.vy * MOVE.camFollow, -170, 250);
    zoom = lerp(1, MOVE.zoomFast, clamp(PS.speed / MOVE.burstMax, 0, 1));
    ease = MOVE.camEase;
  } else {
    ease = mode === 'settle' ? MOVE.camEase : MOVE.camEaseRest;
  }
  ty -= 30;                        // zeminden biraz daha fazla gökyüzü

  // Görünüm ne kadar öne geçmek isterse istesin, ruh ekranda rahatça
  // kalmalıdır — kareın arka bölümünde oturur, asla kenarının dışında değil.
  // Bu noktanın ötesine geçmek, oyuncuya karakterini göstermeyi bırakır ki
  // bu, ona hedefi göstermemekten daha kötüdür.
  const halfW = VW / (2 * zoom), halfH = VH / (2 * zoom);
  tx = body.x + clamp(tx - body.x, -halfW * MOVE.camHold, halfW * MOVE.camHold);
  ty = body.y + clamp(ty - body.y, -halfH * MOVE.camHold, halfH * MOVE.camHold);

  // Görünümü dünyanın içinde tut, uzaklaşmanın onun daha fazlasını
  // gösterdiği gerçeğine izin vererek. Sınırlar sert değil, paylıdır:
  // tam olarak dünyaya sınırlamak, ruh bir sınır duvarına her tutunduğunda
  // onu ekranın tam kenarına yapıştırıyordu, nişan halkası yarı kesik halde.
  const hw = halfW - CAM_PAD, hh = halfH - CAM_PAD;
  tx = world.w <= hw * 2 ? world.w / 2 : clamp(tx, hw, world.w - hw);
  ty = world.h <= hh * 2 ? world.h / 2 : clamp(ty, hh, world.h - hh);

  cam.tx = tx; cam.ty = ty; cam.tzoom = zoom;
  if (snap) { cam.x = tx; cam.y = ty; cam.zoom = zoom; return; }
  cam.x += (tx - cam.x) * ease;
  cam.y += (ty - cam.y) * ease;
  // Yakınlaştırma için tek yumuşatma adımı. Dünya adımında değil burada
  // yaşar, çünkü tutulan bir gerilme adımın geri kalanını tamamen atlar ve
  // görünüm, oyuncu karar verirken yine de yerleşmesini bitirmek zorundadır.
  cam.zoom += (cam.tzoom + cam.punch - cam.zoom) * MOVE.zoomEase;
}

/* ============================================================
   9. ÇİZİM (RENDERING)
   ============================================================ */

let RS = 1;
let fitPending = false;          // sürükleme bitene kadar ertelenmiş bir yeniden boyutlandırma
let canvasRect = { left: 0, top: 0, width: VW, height: VH };

function fit() {
  const rect = canvasRect = dom.canvas.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  // Arka belleği bir hareket ortasında yeniden atamak, işaretçi yakalamayı
  // kaybettirir ve oyuncunun ortasında olduğu bir sürüklemeyi kesebilir.
  // Burada hiçbir şey acil değil, bu yüzden elleri ekrandan çekilene kadar bekler.
  if (Aim.on) { fitPending = true; return; }
  fitPending = false;
  /* DPR çarpanı değil, piksel bütçesi. Bir telefonda bu oyunu öldüren şey
     doldurma hızıdır: her kare bir arkaplan artı bir yığın toplamalı parıltı yazar. */
  const budget = Q.level < 1 ? PIXEL_BUDGET_LOW : PIXEL_BUDGET;
  const maxScale = Math.sqrt(budget / (rect.width * rect.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 2, maxScale);
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (dom.canvas.width !== w || dom.canvas.height !== h) {
    dom.canvas.width = w; dom.canvas.height = h;
    RS = w / VW;
  }
}

/* ---- arkaplan: bir gradyan, bir paralaks kafes ve uzak şekiller ---------- */
const bgGfx = {};
function drawBackground(c) {
  const g = grad(bgGfx, 'sky' + world.bg[0], () => {
    const gr = c.createLinearGradient(0, 0, 0, VH);
    gr.addColorStop(0, world.bg[0]);
    gr.addColorStop(1, world.bg[1]);
    return gr;
  });
  c.fillStyle = g;
  c.fillRect(0, 0, VW, VH);

  const acc = world.accent;
  // iki paralaks kafes: ucuzdur ve dünyanın derin okunmasını sağlar
  for (let layer = 0; layer < 2; layer++) {
    const p = layer === 0 ? 0.25 : 0.5;
    const step = layer === 0 ? 96 : 150;
    const ox = -(cam.x * p) % step, oy = -(cam.y * p) % step;
    c.strokeStyle = rgba(acc, layer === 0 ? 0.05 : 0.075);
    c.lineWidth = 1;
    c.beginPath();
    for (let x = ox; x < VW + step; x += step) { c.moveTo(x, 0); c.lineTo(x, VH); }
    for (let y = oy; y < VH + step; y += step) { c.moveTo(0, y); c.lineTo(VW, y); }
    c.stroke();
  }
  // kamerayla birlikte sürüklenen yumuşak bir parıltı; böylece hareket
  // gökyüzünde bile hissedilir
  const r = 260;
  const gg = grad(bgGfx, 'glow' + acc[0], () => {
    const q = c.createRadialGradient(0, 0, 0, 0, 0, r);
    q.addColorStop(0, rgba(acc, 0.16));
    q.addColorStop(1, rgba(acc, 0));
    return q;
  });
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.translate(VW * 0.5 - (cam.x * 0.12) % (VW * 2), VH * 0.34 - (cam.y * 0.12) % (VH * 2));
  c.fillStyle = gg;
  c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill();
  c.restore();
}

function inView(e, pad) {
  pad = pad || 80;
  const reach = (e.br || e.r || 30) + pad;
  // uzaklaşmak daha fazla dünya gösterir, bu yüzden ayıklamanın da onunla
  // birlikte genişlemesi gerekir
  return Math.abs(e.x - cam.x) < VW / (2 * cam.zoom) + reach &&
         Math.abs(e.y - cam.y) < VH / (2 * cam.zoom) + reach;
}

/* ---- sıradan yüzey: ruhun üzerinde dinlenebileceği taş -------------------
   Sınır duvarları binlerce birim uzunluğundadır ve her zaman yalnızca bir
   ekran yüksekliği kadarı görünür; bu yüzden döndürülmemiş bir yüzey
   görünüme kırpılarak çizilir. Aydınlık üst kenar — oyuncunun gerçekten
   nişan aldığı çizgi — gerçek kenar ekrandayken korunur. */
function drawSolid(c, e) {
  if (e.broken) return;
  let hw = e.w / 2, hh = e.h / 2;
  let ox = 0, oy = 0, topReal = true;
  if (!e.a && (e.w > VW || e.h > VH)) {
    const vw = VW / cam.zoom, vh = VH / cam.zoom;
    const x0 = Math.max(e.x - hw, cam.x - vw), x1 = Math.min(e.x + hw, cam.x + vw);
    const y0 = Math.max(e.y - hh, cam.y - vh), y1 = Math.min(e.y + hh, cam.y + vh);
    if (x1 <= x0 || y1 <= y0) return;
    topReal = y0 <= e.y - hh + 0.5;
    ox = (x0 + x1) / 2 - e.x; oy = (y0 + y1) / 2 - e.y;
    hw = (x1 - x0) / 2; hh = (y1 - y0) / 2;
  }
  const w = hw * 2, h = hh * 2;
  const col = HUE.stone;
  c.save();
  c.translate(e.x + ox, e.y + oy);
  if (e.a) c.rotate(e.a);

  c.fillStyle = 'rgba(10,14,32,0.92)';
  roundRect(c, -hw, -hh, w, h, Math.min(9, hh, hw));
  c.fill();
  if (!topReal) { c.restore(); return; }     // ekran dışı dilim: yalnızca gövde

  // Aydınlık yüz, üst kenara sabitlenmiş kendi uzayında çizilir; böylece
  // önbelleğe alınmış gradyan, altındaki gövde her karede farklı bir
  // yüksekliğe kırpılırken bile geçerli kalır.
  c.globalCompositeOperation = 'lighter';
  const faceH = Math.min(26, h);
  const g = grad(e.gfx, 'face', () => {
    const q = c.createLinearGradient(0, 0, 0, 26);
    q.addColorStop(0, rgba(col.hi, 0.3));
    q.addColorStop(1, rgba(col.rgb, 0));
    return q;
  });
  c.save();
  c.translate(0, -hh);
  c.fillStyle = g;
  roundRect(c, -hw, 0, w, faceH, Math.min(9, hh, hw));
  c.fill();
  c.restore();
  c.globalCompositeOperation = 'source-over';

  // üst kenar boyunca aydınlık bir dudak: oyuncunun gerçekten nişan aldığı çizgi budur
  c.strokeStyle = rgba(col.hi, 0.5);
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(-hw + 6, -hh + 1); c.lineTo(hw - 6, -hh + 1);
  c.stroke();
  c.strokeStyle = rgba(col.rgb, 0.3);
  c.lineWidth = 1.2;
  roundRect(c, -hw + 1, -hh + 1, w - 2, h - 2, Math.min(8, hh, hw));
  c.stroke();
  c.restore();
}

/* ---- ruh yayı: işaret ettiği yöne seni fırlatan bir çiçeklenme ----------- */
function drawSpring(c, s) {
  const col = HUE.spring;
  const hw = s.w / 2, hh = s.h / 2;
  const fire = s.fire;
  const breathe = 0.5 + 0.5 * Math.sin(Vis.pulse * 2.2 + s.seed);
  c.save();
  c.translate(s.x, s.y);
  c.rotate(s.a);

  c.fillStyle = 'rgba(8,20,22,0.9)';
  roundRect(c, -hw, -hh, s.w, s.h, hh);
  c.fill();

  c.globalCompositeOperation = 'lighter';
  const g = grad(s.gfx, 'bloom', () => {
    const q = c.createRadialGradient(0, 0, 4, 0, 0, hw * 1.3);
    q.addColorStop(0, rgba(col.rgb, 0.5));
    q.addColorStop(1, rgba(col.rgb, 0));
    return q;
  });
  c.globalAlpha = 0.5 + breathe * 0.2 + fire * 0.5;
  c.fillStyle = g;
  c.beginPath(); c.ellipse(0, 0, hw * 1.3, hh * 3.2, 0, 0, TAU); c.fill();
  c.globalAlpha = 1;

  // dışa doğru yaslanan yapraklar, ateşlendiğinde açılıyor
  const open = 0.2 + breathe * 0.12 + fire * 0.7;
  c.strokeStyle = rgba(col.hi, 0.75);
  c.lineWidth = 2.4;
  const n = Math.max(3, Math.round(s.w / 42));
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const x = lerp(-hw + 12, hw - 12, t);
    const lean = (t - 0.5) * 22;
    c.beginPath();
    c.moveTo(x, hh * 0.2);
    c.quadraticCurveTo(x + lean * 0.5, -hh - 10 - open * 16, x + lean, -hh - 16 - open * 26);
    c.stroke();
  }
  // Fırlatma yönü boyunca sürüklenen bir parçacık akışı. Ok hangi yönü
  // söyler; bu da onu tekrar söyler, sürekli olarak, oyuncunun hiçbir şey
  // okumasına gerek kalmadan — yön bölümün her yerinden okunabilir.
  const flow = (Vis.pulse * 0.55 + s.seed) % 1;
  for (let i = 0; i < 4; i++) {
    const u = (flow + i / 4) % 1;
    const d = -hh - 8 - u * 92;
    const fade = Math.sin(u * Math.PI);
    c.fillStyle = rgba(col.hi, 0.5 * fade * (0.5 + fire * 0.5));
    c.beginPath();
    c.arc((i % 2 ? 1 : -1) * 14 * (1 - u * 0.6), d, 2.6 * (1 - u * 0.4), 0, TAU);
    c.fill();
  }

  // ok: nesnenin verdiği söz budur
  c.strokeStyle = rgba(col.hi, 0.55 + fire * 0.45);
  c.lineWidth = 3;
  const tip = -hh - 34 - open * 16;
  c.beginPath();
  c.moveTo(0, tip + 20); c.lineTo(0, tip);
  c.moveTo(-8, tip + 9); c.lineTo(0, tip); c.lineTo(8, tip + 9);
  c.stroke();
  c.globalCompositeOperation = 'source-over';
  c.restore();
}

/* ---- enerji düğümü: seni uçuş ortasında yakalayan şey ----------------- */
function drawNode(c, n) {
  const col = HUE.node;
  const charged = n.cool <= 0;
  const live = charged ? 1 : 1 - n.cool / MOVE.nodeCool;
  const near = PS.state === 'air' && charged &&
               Math.hypot(body.x - n.x, body.y - n.y) < MOVE.nodeReach;
  const held = PS.node === n;
  const breathe = 0.5 + 0.5 * Math.sin(Vis.pulse * 2.6 + n.seed);

  c.save();
  c.translate(n.x, n.y);
  c.globalCompositeOperation = 'lighter';

  // erişim halkası — yalnızca gerçekten seni alabilecekken, bu yüzden asla yalan söylemez
  if (near || held) {
    c.strokeStyle = rgba(col.rgb, held ? 0.3 : 0.16 + breathe * 0.1);
    c.lineWidth = 2;
    c.setLineDash([6, 10]);
    c.lineDashOffset = -n.spin * 22;
    c.beginPath(); c.arc(0, 0, MOVE.nodeReach * (held ? 0.5 : 0.9), 0, TAU); c.stroke();
    c.setLineDash([]);
  }

  const g = grad(n.gfx, 'glow', () => {
    const q = c.createRadialGradient(0, 0, 2, 0, 0, n.r * 2.6);
    q.addColorStop(0, rgba(col.rgb, 0.55));
    q.addColorStop(0.4, rgba(col.rgb, 0.16));
    q.addColorStop(1, rgba(col.rgb, 0));
    return q;
  });
  c.globalAlpha = charged ? 0.6 + breathe * 0.25 + n.glow * 0.4 + (near ? 0.25 : 0) : 0.14;
  c.fillStyle = g;
  c.beginPath(); c.arc(0, 0, n.r * 2.6, 0, TAU); c.fill();
  c.globalAlpha = 1;

  // üç sürüklenen yaprak
  c.rotate(n.spin * 0.6);
  c.strokeStyle = rgba(charged ? col.hi : col.rgb, charged ? 0.8 : 0.28);
  c.lineWidth = 2.2;
  for (let i = 0; i < 3; i++) {
    const a = i * TAU / 3;
    c.save(); c.rotate(a);
    const rr = n.r * (0.92 + (charged ? breathe * 0.12 : 0) + (near ? 0.14 : 0));
    c.beginPath();
    c.moveTo(0, -rr * 0.35);
    c.quadraticCurveTo(rr * 0.8, -rr * 0.6, 0, -rr * 1.25);
    c.quadraticCurveTo(-rr * 0.8, -rr * 0.6, 0, -rr * 0.35);
    c.stroke();
    c.restore();
  }
  c.rotate(-n.spin * 0.6);

  // çekirdek
  c.fillStyle = rgba(charged ? col.hi : col.rgb, charged ? 0.9 : 0.3);
  c.beginPath(); c.arc(0, 0, n.r * (0.3 + (charged ? breathe * 0.07 : 0)), 0, TAU); c.fill();

  // yeniden şarj yayı — kararmış düğümler tam olarak ne zaman geri geleceklerini söyler
  if (!charged) {
    c.strokeStyle = rgba(col.rgb, 0.5);
    c.lineWidth = 2.6;
    c.beginPath();
    c.arc(0, 0, n.r * 1.05, -Math.PI / 2, -Math.PI / 2 + TAU * live);
    c.stroke();
  }
  c.globalCompositeOperation = 'source-over';
  c.restore();
}

/* ---- kontrol noktası ----------------------------------------------------- */
function drawMote(c, m) {
  const col = HUE.mote;
  const breathe = 0.5 + 0.5 * Math.sin(Vis.pulse * 1.8 + m.seed);
  c.save();
  c.translate(m.x, m.y + (m.got ? 0 : Math.sin(Vis.pulse * 1.4 + m.seed) * 3));
  c.globalCompositeOperation = 'lighter';
  const g = grad(m.gfx, 'glow', () => {
    const q = c.createRadialGradient(0, 0, 1, 0, 0, m.r * 2.4);
    q.addColorStop(0, rgba(col.rgb, 0.5));
    q.addColorStop(1, rgba(col.rgb, 0));
    return q;
  });
  c.globalAlpha = (m.got ? 0.85 : 0.3) + breathe * 0.15 + m.pop * 0.5;
  c.fillStyle = g;
  c.beginPath(); c.arc(0, 0, m.r * 2.4 * (1 + m.pop * 0.3), 0, TAU); c.fill();
  c.globalAlpha = 1;

  c.strokeStyle = rgba(col.hi, m.got ? 0.85 : 0.35);
  c.lineWidth = 2;
  c.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = i * TAU / 6 + (m.got ? Vis.pulse * 0.5 : 0);
    const rr = m.r * (m.got ? 0.95 : 0.7);
    const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
    if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
  }
  c.closePath(); c.stroke();
  c.fillStyle = rgba(col.hi, m.got ? 0.9 : 0.3);
  c.beginPath(); c.arc(0, 0, m.r * 0.26, 0, TAU); c.fill();
  c.globalCompositeOperation = 'source-over';
  c.restore();
}

/* ---- öldürücü çıkıntılar ve ışınlar -------------------------------------------- */
function drawLethal(c, e) {
  const k = e.k === undefined ? 1 : e.k;
  const hw = e.w / 2, hh = e.h / 2;
  c.save();
  c.translate(e.x, e.y);
  if (e.a) c.rotate(e.a);

  if (e.spikes) {
    const horizontal = e.w >= e.h;
    const len = Math.max(e.w, e.h), depth = Math.min(e.w, e.h);
    const teeth = Math.max(2, Math.round(len / 26));
    c.fillStyle = 'rgba(14,6,20,0.92)';
    roundRect(c, -hw, -hh, e.w, e.h, 4); c.fill();
    c.globalCompositeOperation = 'lighter';
    c.fillStyle = rgba(DANGER, 0.3);
    c.strokeStyle = rgba(DANGER, 0.85);
    c.lineWidth = 1.6;
    c.beginPath();
    for (let i = 0; i < teeth; i++) {
      const t0 = -len / 2 + i * (len / teeth), t1 = t0 + len / teeth;
      const tm = (t0 + t1) / 2;
      if (horizontal) {
        c.moveTo(t0, depth / 2); c.lineTo(tm, -depth / 2); c.lineTo(t1, depth / 2);
      } else {
        c.moveTo(depth / 2, t0); c.lineTo(-depth / 2, tm); c.lineTo(depth / 2, t1);
      }
    }
    c.fill(); c.stroke();
    c.globalCompositeOperation = 'source-over';
    c.restore();
    return;
  }

  // ışın: her zaman sönük bir ray, tehlikeliyken aydınlık bir sütun
  c.fillStyle = rgba([60, 20, 40], 0.5);
  roundRect(c, -hw * 0.3, -hh, e.w * 0.3, e.h, 3); c.fill();
  c.strokeStyle = rgba(DANGER, 0.22);
  c.lineWidth = 1.2;
  roundRect(c, -hw * 0.3, -hh, e.w * 0.3, e.h, 3); c.stroke();

  if (k > 0.02) {
    c.globalCompositeOperation = 'lighter';
    const g = grad(e.gfx, 'beam', () => {
      const q = c.createLinearGradient(-hw, 0, hw, 0);
      q.addColorStop(0, rgba(DANGER, 0));
      q.addColorStop(0.5, rgba(DANGER, 0.7));
      q.addColorStop(1, rgba(DANGER, 0));
      return q;
    });
    c.globalAlpha = k;
    c.fillStyle = g;
    c.fillRect(-hw * 1.5, -hh, e.w * 1.5, e.h);
    c.fillStyle = rgba([255, 220, 236], 0.85 * k);
    c.fillRect(-hw * 0.16, -hh, e.w * 0.16, e.h);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  }
  c.restore();
}

/* ---- geçit ----------------------------------------------------------- */
function drawGate(c, g) {
  const col = HUE.gate;
  const breathe = 0.5 + 0.5 * Math.sin(Vis.pulse * 1.6);
  c.save();
  c.translate(g.x, g.y);
  c.globalCompositeOperation = 'lighter';
  const gg = grad(g.gfx, 'glow', () => {
    const q = c.createRadialGradient(0, 0, 4, 0, 0, g.r * 2.6);
    q.addColorStop(0, rgba(col.rgb, 0.5));
    q.addColorStop(0.45, rgba(col.rgb, 0.14));
    q.addColorStop(1, rgba(col.rgb, 0));
    return q;
  });
  c.globalAlpha = 0.6 + breathe * 0.2 + g.open * 0.5;
  c.fillStyle = gg;
  c.beginPath(); c.arc(0, 0, g.r * 2.6 * (1 + g.open * 0.3), 0, TAU); c.fill();
  c.globalAlpha = 1;

  for (let i = 0; i < 3; i++) {
    const rr = g.r * (0.5 + i * 0.26) * (1 + g.open * 0.2);
    const sp = Vis.pulse * (0.4 + i * 0.22) * (i % 2 ? -1 : 1);
    c.strokeStyle = rgba(col.hi, 0.5 - i * 0.12 + g.open * 0.3);
    c.lineWidth = 2 - i * 0.4;
    c.beginPath();
    c.arc(0, 0, rr, sp, sp + TAU * 0.68);
    c.stroke();
  }
  c.fillStyle = rgba(col.hi, 0.75 + breathe * 0.2);
  c.beginPath(); c.arc(0, 0, g.r * 0.2 * (1 + g.open), 0, TAU); c.fill();
  c.globalCompositeOperation = 'source-over';
  c.restore();
}

/* ---- ruh --------------------------------------------------------- */
const spiritGfx = {};

function drawTrail(c) {
  if (PS.speed < 3 || PS.state === 'hurt') return;
  const n = Math.min(Vis.trailN, Q.level < 1 ? (TRAIL_N >> 1) : TRAIL_N);
  if (n < 3) return;
  const k = clamp(PS.speed / 18, 0, 1);
  c.globalCompositeOperation = 'lighter';
  c.lineCap = 'round'; c.lineJoin = 'round';
  c.beginPath();
  for (let i = 1; i < n; i++) {
    const p = Vis.trail[(Vis.trailN - n + i + TRAIL_N * 4) % TRAIL_N];
    if (i === 1) c.moveTo(p.x, p.y); else c.lineTo(p.x, p.y);
  }
  const head = Vis.trail[(Vis.trailN - 1 + TRAIL_N * 4) % TRAIL_N];
  const tail = Vis.trail[(Vis.trailN - n + TRAIL_N * 4) % TRAIL_N];
  const g = c.createLinearGradient(tail.x, tail.y, head.x, head.y);
  g.addColorStop(0, rgba(HUE.spirit.rgb, 0));
  g.addColorStop(0.6, rgba(HUE.spirit.rgb, 0.14 * k));
  g.addColorStop(1, rgba(HUE.spirit.hi, 0.45 * (0.3 + k * 0.7)));
  c.strokeStyle = g;
  c.lineWidth = body.r * (0.55 + k * 0.6);
  c.stroke();
  c.globalCompositeOperation = 'source-over';
}

/* Prosedürel olarak çizilmiş küçük bir yaratık: yumuşak bir gövde, hareketin
   arkasında sürüklenen iki uzun kulak ve gittiği yöne bakan gözler. Bu,
   modellenmiş bir karakter için bir yer tutucudur, ama ilk kareden itibaren
   canlı okunması gerekir; bu yüzden buradaki her şey, bir riggin eninde
   sonunda tüketeceği aynı squash/stretch/look değerleriyle yönetilir. */
function drawSpirit(c) {
  if (Vis.scale <= 0.02) return;
  const r = body.r * Vis.scale;
  const col = HUE.spirit;

  drawTrail(c);

  let stretch = Vis.stretch, sang = Vis.stretchAng;
  let ox = 0, oy = 0;
  if (Aim.on && Aim.power > 0) {
    // Atışı doldurmak: ruh çekiş boyunca geriye yaslanır ve ona doğru
    // sıkışır; böylece gerilme yalnızca bantta değil, karakterde de
    // hissedilir. Yaslanır, hareket etmez — gövde konumu asla kaymaz.
    const a = Aim.angle + Math.PI;
    ox = Math.cos(a) * Aim.power * 11;
    oy = Math.sin(a) * Aim.power * 11;
    stretch = Aim.power * 0.24;
    sang = a;
  }
  const sq = Vis.squash;
  const bob = PS.state === 'ground' && PS.speed < 0.5 ? Math.sin(Vis.pulse * 2.4) * 1.5 : 0;
  const x = body.x + ox, y = body.y + oy + bob;

  const pop = 1 + Vis.landPop * 0.0 + Vis.readyPop * 0.06;

  c.save();
  c.translate(x, y);
  if (pop !== 1) c.scale(pop, pop);

  // çiçeklenme
  c.globalCompositeOperation = 'lighter';
  const bloom = grad(spiritGfx, 'bloom', () => {
    const q = c.createRadialGradient(0, 0, body.r * 0.3, 0, 0, body.r * 3);
    q.addColorStop(0, rgba(col.rgb, 0.5));
    q.addColorStop(0.35, rgba(col.rgb, 0.15));
    q.addColorStop(1, rgba(col.rgb, 0));
    return q;
  });
  const bs = (r / body.r) * (1 + Vis.flash * 0.3 + Aim.power * 0.22 + clamp(PS.speed / 20, 0, 1) * 0.2);
  c.save();
  c.scale(bs, bs);
  c.globalAlpha = Math.min(1, 0.6 + Vis.flash * 0.3 + Aim.power * 0.2 + Vis.readyPop * 0.15);
  c.fillStyle = bloom;
  c.beginPath(); c.arc(0, 0, body.r * 3, 0, TAU); c.fill();
  c.globalAlpha = 1;
  c.restore();
  c.globalCompositeOperation = 'source-over';

  // --- gövde, stretch / squash'tan hangisi baskınsa ona göre deforme edilir ---
  c.save();
  const ang = sq > stretch ? Vis.squashAng : sang;
  c.rotate(ang);
  c.scale(1 + stretch + sq * 0.36, 1 - stretch * 0.52 - sq * 0.3);
  c.rotate(-ang);
  c.scale(r / body.r, r / body.r);

  const look = Vis.lookT;
  const lx = Math.cos(look), ly = Math.sin(look);
  const R = body.r;

  // Kulaklar: kafanın tepesinden inceleşen iki uzantı. Bakış yönü yerine
  // ekran-yukarısı üzerinde otururlar; yaratığın nasıl uçarsa uçsun dik
  // okunmasını sağlayan da budur ve hareketin arkasında sürüklenirler — bu
  // yaslanma, şeyin süslü bir disk değil canlı okunmasını sağlayan şeyin çoğudur.
  const lean = clamp(-body.vx / 26, -0.75, 0.75) +
               (PS.state === 'cling' ? PS.clingSide * 0.3 : 0);
  const lift = clamp(-body.vy / 40, -0.3, 0.3);
  c.save();
  c.lineCap = 'round';
  for (let i = 0; i < 2; i++) {
    const side = i ? 1 : -1;
    const base = -Math.PI / 2 + side * 0.52;
    const wob = Math.sin(Vis.pulse * 2.3 + i * 1.9) * (PS.state === 'node' ? .15 : .08);
    const tipA = base + side * 0.1 + lean + wob;
    const midA = base + side * 0.04 + lean * 0.45 + wob * 0.5;
    const bx = Math.cos(base) * R * 0.66, by = Math.sin(base) * R * 0.66;
    const mx = Math.cos(midA) * R * 1.35, my = Math.sin(midA) * R * 1.35 - lift * R * 0.3;
    const tx = Math.cos(tipA) * R * 2.05, ty2 = Math.sin(tipA) * R * 2.05 - lift * R * 0.5;
    // dış kulak
    c.strokeStyle = rgba([110, 170, 225], 0.85);
    c.lineWidth = R * 0.34;
    c.beginPath(); c.moveTo(bx, by); c.quadraticCurveTo(mx, my, tx, ty2); c.stroke();
    // iç kulak, daha kısa ve daha parlak; böylece her kulak bir çizgi değil bir şekil olarak okunur
    c.strokeStyle = rgba(col.hi, 0.9);
    c.lineWidth = R * 0.15;
    c.beginPath();
    c.moveTo(bx, by);
    c.quadraticCurveTo(mx * 0.96, my * 0.96, tx * 0.82, ty2 * 0.82);
    c.stroke();
  }
  c.restore();

  // gövde
  const shell = grad(spiritGfx, 'shell', () => {
    const q = c.createRadialGradient(-R * 0.3, -R * 0.35, R * 0.1, 0, 0, R * 1.05);
    q.addColorStop(0, rgba(col.hi, 0.98));
    q.addColorStop(0.45, rgba(col.rgb, 0.88));
    q.addColorStop(1, rgba([90, 150, 210], 0.6));
    return q;
  });
  c.fillStyle = shell;
  c.beginPath(); c.ellipse(0, R * 0.05, R * 0.98, R * 1.04, 0, 0, TAU); c.fill();

  // bakış yönünün tersine küçük bir kuyruk tutamı
  c.globalCompositeOperation = 'lighter';
  c.strokeStyle = rgba(col.rgb, 0.5);
  c.lineWidth = R * 0.24;
  c.beginPath();
  c.moveTo(-lx * R * 0.7, -ly * R * 0.7 + R * 0.3);
  c.quadraticCurveTo(-lx * R * 1.5, -ly * R * 1.5 + R * 0.7,
                     -lx * R * 1.9 + ly * R * 0.5, -ly * R * 1.9 - lx * R * 0.5 + R * 0.5);
  c.stroke();
  c.globalCompositeOperation = 'source-over';

  // Yüz. Gözler, gövdenin üst yarısında seviyeli bir çift olarak kalır ve
  // yalnızca ruhun baktığı yöne doğru biraz kayar — onların bakış yönüyle
  // tüm gövdenin etrafında dönmesine izin vermek, bunu bir yüz yerine
  // üzerinde desen olan bir top gibi okutuyordu.
  const gx = lx * R * 0.26, gy = ly * R * 0.16 - R * 0.16;
  const open = Vis.blink > 0 ? 0.1 : 1;
  for (let i = 0; i < 2; i++) {
    const side = i ? 1 : -1;
    const ex = gx + side * R * 0.32, ey = gy;
    c.fillStyle = 'rgba(12,20,42,0.94)';
    c.beginPath();
    c.ellipse(ex, ey, R * 0.17, R * 0.24 * open, 0, 0, TAU);
    c.fill();
    if (open > 0.5) {
      c.fillStyle = 'rgba(255,255,255,0.95)';
      c.beginPath();
      c.arc(ex + lx * R * 0.04 + side * R * 0.04, ey - R * 0.08, R * 0.065, 0, TAU);
      c.fill();
    }
  }
  // gözlerin altında belli belirsiz bir ışık pembeliği, böylece yüzün bir hacmi olur
  c.globalCompositeOperation = 'lighter';
  c.fillStyle = rgba(col.hi, 0.18);
  c.beginPath(); c.ellipse(gx, gy + R * 0.42, R * 0.32, R * 0.13, 0, 0, TAU); c.fill();
  // gövdenin altında, boşta nabzıyla nefes alan iki küçük işaret
  c.fillStyle = rgba(col.hi, 0.42 + Math.sin(Vis.pulse * 3) * 0.14);
  for (let i = 0; i < 2; i++) {
    const side = i ? 1 : -1;
    c.beginPath(); c.arc(side * R * 0.34, R * 0.62, R * 0.08, 0, TAU); c.fill();
  }
  c.globalCompositeOperation = 'source-over';
  c.restore();
  c.restore();
}

/* ---- gerilme kılavuzu ----------------------------------------------------
   Önizleme, çizici tarafından değil, simülasyon tarafından tazelenir; çünkü
   kameranın da buna ihtiyacı vardır: görünümün kadraja alması gereken şey
   "nişan boyunca bir mesafe" değil, bu sıçramanın gerçekten vardığı yerdir. */
let lastPvx = NaN, lastPvy = NaN, lastPvf = -99;

/* Mevcut gerilmenin, duvar kuralları dahil, üreteceği hız. */
function aimVelocity(out) {
  const fromNode = PS.state === 'node';
  const sp = launchSpeed(Aim.power, fromNode);
  if (PS.state === 'cling') return applyClingKick(Aim.angle, sp, out);
  out.x = Math.cos(Aim.angle) * sp;
  out.y = Math.sin(Aim.angle) * sp;
  return out;
}
const AIMV = { x: 0, y: 0 };

function refreshAimPreview() {
  if (!Aim.on || Aim.pullLen <= MOVE.dragDead) { preview.n = 0; return; }
  const v = aimVelocity(AIMV);
  // bir tutunuştan gelen önizleme, gerçek sıçramanın alacağı aynı yeniden tutunma bekleme süresini alır
  probe.noWall = PS.state === 'cling' ? PS.clingWall : null;
  probe.noWallT = PS.state === 'cling' ? MOVE.wallRegrab : 0;
  probe.ledgeDir = 0; probe.ledgeT = 0;
  if (PS.state === 'cling') armLedgeAssist(probe, Aim.angle, Math.hypot(v.x, v.y));
  const moving = world.movers.length || world.beams.length;
  if (v.x !== lastPvx || v.y !== lastPvy || (moving && frameCount - lastPvf > 3)) {
    lastPvx = v.x; lastPvy = v.y; lastPvf = frameCount;
    // Çoğu yayın sonuna ulaşacak kadar uzun. Yer çekimli bir oyunda yay,
    // bilginin KENDİSİDİR — nereye ineceğini gizlemek nişan almayı tahmine
    // çevirir — bu yüzden kılavuz kesilmek yerine inişe kadar gider ve
    // sonra söner. Yine de karşılaştığı ilk şeyde durur, asla tüm rotayı göstermez.
    predict(body.x, body.y, v.x, v.y, lerp(520, 1000, Aim.power));
  }
}

function drawAim(c) {
  if (!Aim.on || Aim.pullLen <= MOVE.dragDead) return;
  const fromNode = PS.state === 'node';
  const col = fromNode ? HUE.node : HUE.spirit;
  const a = Aim.angle, p = Aim.power;
  const pv = preview;
  if (!pv.n) return;

  c.globalCompositeOperation = 'lighter';
  for (let i = 0; i < pv.n; i++) {
    const u = i / Math.max(1, pv.n - 1);
    const q = pv.pts[i];
    const fade = 1 - u * u * 0.8;
    c.fillStyle = rgba(i < 2 ? col.hi : col.rgb, 0.14 + fade * 0.55);
    c.beginPath(); c.arc(q.x, q.y, lerp(4.2, 1.5, u), 0, TAU); c.fill();
  }

  /* Nerede bittiği. Kılavuzun bütün amacı budur: oyuncu, denemek zorunda
     kalmadan "şimdi bırakırsam nereye inerim?" sorusunu cevaplayabilmelidir.
     Güvenli bir varış, altında küçük bir zemin işaretli bir iniş halkası
     alır; öldürücü bir tanesi bir çarpı alır; bir yay, yayın kendi rengini
     alır, böylece "buradan fırlatılacaksın" diye okunur, "burada
     duracaksın" diye değil. */
  if (pv.n > 0) {
    const q = pv.pts[pv.n - 1];
    const bl = 0.6 + 0.4 * Math.sin(Vis.pulse * 5);
    if (pv.danger) {
      c.strokeStyle = rgba(DANGER, 0.55 + bl * 0.4);
      c.lineWidth = 2.4;
      c.beginPath(); c.arc(q.x, q.y, 11, 0, TAU); c.stroke();
      c.beginPath();
      c.moveTo(q.x - 5, q.y - 5); c.lineTo(q.x + 5, q.y + 5);
      c.moveTo(q.x + 5, q.y - 5); c.lineTo(q.x - 5, q.y + 5);
      c.stroke();
    } else if (pv.spring) {
      c.strokeStyle = rgba(HUE.spring.hi, 0.5 + bl * 0.3);
      c.lineWidth = 2.4;
      c.beginPath(); c.arc(q.x, q.y, 12, 0, TAU); c.stroke();
    } else if (pv.land >= 0) {
      const safe = pv.landFloor;
      const lc = safe ? HUE.spirit.hi : [200, 220, 255];
      c.strokeStyle = rgba(lc, 0.45 + bl * 0.3);
      c.lineWidth = 2.4;
      c.beginPath(); c.arc(q.x, q.y, 11, 0, TAU); c.stroke();
      if (safe) {
        // halkanın altında düz bir zemin: "bu, üzerinde durabileceğin bir yüzey"
        c.strokeStyle = rgba(lc, 0.5);
        c.lineWidth = 2.6;
        c.beginPath();
        c.moveTo(q.x - 15, q.y + body.r + 1); c.lineTo(q.x + 15, q.y + body.r + 1);
        c.stroke();
      }
    }
  }

  /* Ruhun iki tarafında iki bilgi parçası; böylece tersine çevirme, oyuncunun
     kafasında yapması gereken bir şey olmaz.

     ARKADA: lastik. Çekiş boyunca geriye uzanan, ucunda bir tutamacı olan
     bir gerilim çizgisi. Gerilme büyüdükçe kalınlaşır ve parlaklaşır; ham
     işaretçiden değil, gerilme vektöründen çizilir, bu yüzden kamera
     hareket ederken bile kaya gibi sabit kalır.

     ÖNDE: fırlatma. Yay, üstündeki iniş halkası ve bir ok. */
  const back = a + Math.PI;
  const R = body.r + 14 + p * 8;
  const pullLen = R + 16 + p * 62;
  const bx = body.x + Math.cos(back) * pullLen;
  const by = body.y + Math.sin(back) * pullLen;
  const eg = c.createLinearGradient(body.x, body.y, bx, by);
  eg.addColorStop(0, rgba(col.hi, 0.5 + p * 0.3));
  eg.addColorStop(1, rgba(col.rgb, 0.08));
  c.strokeStyle = eg;
  c.lineWidth = lerp(2.4, 6, p);       // gerildikçe bant kalınlaşır
  c.lineCap = 'round';
  c.beginPath(); c.moveTo(body.x, body.y); c.lineTo(bx, by); c.stroke();
  c.fillStyle = rgba(col.hi, 0.35 + p * 0.4);
  c.beginPath(); c.arc(bx, by, 3.5 + p * 3.5, 0, TAU); c.fill();

  // fırlatma oku, ruhun önünde, gerilmeyle birlikte büyüyor
  const fx = body.x + Math.cos(a) * (R + 10 + p * 34);
  const fy = body.y + Math.sin(a) * (R + 10 + p * 34);
  const fg = c.createLinearGradient(body.x, body.y, fx, fy);
  fg.addColorStop(0, rgba(col.rgb, 0.1));
  fg.addColorStop(1, rgba(col.hi, 0.55 + p * 0.35));
  c.strokeStyle = fg;
  c.lineWidth = lerp(2, 4.5, p);
  c.beginPath(); c.moveTo(body.x, body.y); c.lineTo(fx, fy); c.stroke();

  c.strokeStyle = rgba(col.rgb, 0.2);
  c.lineWidth = 2.4;
  c.beginPath(); c.arc(body.x, body.y, R, 0, TAU); c.stroke();
  c.strokeStyle = rgba(col.hi, 0.9);
  c.lineWidth = 3;
  c.beginPath(); c.arc(body.x, body.y, R, -Math.PI / 2, -Math.PI / 2 + TAU * p); c.stroke();

  c.save();
  c.translate(body.x, body.y); c.rotate(a);
  for (let i = 0; i < 3; i++) {
    const d = R + 9 + i * 7, s = 4 + i * 0.6;
    c.strokeStyle = rgba(col.hi, (0.9 - i * 0.26) * (0.4 + p * 0.6));
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(d - 3, -s); c.lineTo(d + 2, 0); c.lineTo(d - 3, s);
    c.stroke();
  }
  c.restore();
  c.globalCompositeOperation = 'source-over';
}

/* Kontrol geri geldiğinde sessiz bir halka, sadece oturuyorsan yavaş bir nefes. */
function drawReady(c) {
  if (G.phase !== 'play' || Aim.on) return;
  const col = PS.state === 'cling' ? HUE.spirit : HUE.spirit;
  c.globalCompositeOperation = 'lighter';
  if (Vis.readyPop > 0.01) {
    const u = 1 - Vis.readyPop;
    c.strokeStyle = rgba(col.hi, Vis.readyPop * 0.5);
    c.lineWidth = 2.4 - u * 1.2;
    c.beginPath(); c.arc(body.x, body.y, body.r + 3 + easeOut(u) * 24, 0, TAU); c.stroke();
  }
  if (canAim() && PS.t > 1.2 && PS.speed < 1) {
    const t = (Vis.pulse * 0.9) % 1;
    c.strokeStyle = rgba(col.hi, (1 - t) * 0.4 * clamp((PS.t - 1.2) / 0.6, 0, 1));
    c.lineWidth = 2;
    c.beginPath(); c.arc(body.x, body.y, body.r + 7 + t * 30, 0, TAU); c.stroke();
  }
  // biten bir tutunuş: kavrama halkası, tutunuşla birlikte kapanır
  if (PS.state === 'cling') {
    const left = 1 - PS.clingT / MOVE.clingTime;
    c.strokeStyle = rgba(HUE.spirit.hi, 0.3 + left * 0.4);
    c.lineWidth = 2.4;
    c.beginPath();
    c.arc(body.x, body.y, body.r + 9, -Math.PI / 2, -Math.PI / 2 + TAU * left);
    c.stroke();
  }
  if (G.deny > 0.01) {
    c.strokeStyle = rgba([210, 225, 255], G.deny * 0.45);
    c.lineWidth = 2;
    c.beginPath(); c.arc(body.x, body.y, body.r + 34 - (1 - G.deny) * 22, 0, TAU); c.stroke();
  }
  c.globalCompositeOperation = 'source-over';
}

function drawParticles(c) {
  c.globalCompositeOperation = 'lighter';
  for (let i = 0; i < PMAX; i++) {
    const p = parts[i];
    if (!p.on) continue;
    const u = p.life / p.max;
    c.fillStyle = rgba(p.col, u * 0.85);
    if (p.shape === 1) {
      c.strokeStyle = rgba(p.col, u * 0.8);
      c.lineWidth = p.size;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(p.x, p.y);
      c.lineTo(p.x - Math.cos(p.ang) * p.len * u, p.y - Math.sin(p.ang) * p.len * u);
      c.stroke();
    } else {
      c.beginPath(); c.arc(p.x, p.y, p.size * (0.4 + u * 0.6), 0, TAU); c.fill();
    }
  }
  for (let i = 0; i < RMAX; i++) {
    const r = rings[i];
    if (!r.on) continue;
    const u = 1 - r.life / r.max;
    c.strokeStyle = rgba(r.col, (1 - u) * 0.55);
    c.lineWidth = r.w * (1 - u * 0.7);
    c.beginPath(); c.arc(r.x, r.y, lerp(r.r0, r.r1, easeOut(u)), 0, TAU); c.stroke();
  }
  c.globalCompositeOperation = 'source-over';
}

function drawDust(c) {
  c.globalCompositeOperation = 'lighter';
  for (const d of DUST) {
    c.fillStyle = rgba(world.accent, 0.1 + 0.16 * d.z * (0.6 + 0.4 * Math.sin(d.t)));
    c.beginPath(); c.arc(d.x, d.y, d.s * d.z, 0, TAU); c.fill();
  }
  c.globalCompositeOperation = 'source-over';
}

function drawTransition(c) {
  if (G.transDir === 0) return;
  const u = clamp(G.transT / G.transDur, 0, 1);
  const k = G.transDir === 1 ? easeInOut(u) : 1 - easeInOut(u);
  if (k <= 0) return;
  const h = VH / 2 * k;
  const acc = world.accent;
  c.fillStyle = '#05060f';
  c.fillRect(0, 0, VW, h);
  c.fillRect(0, VH - h, VW, h);
  c.globalCompositeOperation = 'lighter';
  const g1 = c.createLinearGradient(0, h - 40, 0, h);
  g1.addColorStop(0, rgba(acc, 0)); g1.addColorStop(1, rgba(acc, 0.55));
  c.fillStyle = g1; c.fillRect(0, h - 40, VW, 40);
  const g2 = c.createLinearGradient(0, VH - h + 40, 0, VH - h);
  g2.addColorStop(0, rgba(acc, 0)); g2.addColorStop(1, rgba(acc, 0.55));
  c.fillStyle = g2; c.fillRect(0, VH - h, VW, 40);
  c.fillStyle = rgba([220, 240, 255], 0.85);
  c.fillRect(0, h - 1.5, VW, 1.5);
  c.fillRect(0, VH - h, VW, 1.5);
  c.globalCompositeOperation = 'source-over';
}


function drawEnvironment(c) {
  for (const e of world.solids) {
    if (e.broken || !inView(e)) continue;
    if (e.motion) {
      c.strokeStyle='rgba(100,225,255,.3)'; c.lineWidth=2; c.setLineDash([5,9]);
      c.beginPath(); c.moveTo(e.bx-(e.motion.dx||0),e.by-(e.motion.dy||0));
      c.lineTo(e.bx+(e.motion.dx||0),e.by+(e.motion.dy||0)); c.stroke(); c.setLineDash([]);
      c.strokeStyle='#80dff7'; c.strokeRect(e.x-e.w/2+5,e.y-e.h/2+5,e.w-10,5);
    }
    if (e.crumble) {
      const k=e.crumbleT<0?0:clamp(e.crumbleT/e.crumble,0,1);
      c.save(); c.translate(e.x+Math.sin(G.t*65)*k*2,e.y-e.h/2);
      c.strokeStyle=k>.5?'#ffc09a':'#b5a2d6'; c.lineWidth=2;
      for(let j=-1;j<=1;j++) { const x=j*e.w*.28; c.beginPath(); c.moveTo(x,-1); c.lineTo(x-9,9); c.lineTo(x+4,17); c.lineTo(x-8,25+k*25); c.stroke(); }
      if(k) { c.fillStyle='#ffd0a1'; c.fillRect(-e.w/2,-7,e.w*(1-k),3); }
      c.restore();
    }
  }
  for (const w of world.winds) {
    if (Math.abs(w.x-cam.x)>w.w/2+VW/cam.zoom || Math.abs(w.y-cam.y)>w.h/2+VH/cam.zoom) continue;
    c.fillStyle='rgba(75,213,222,.035)'; c.fillRect(w.x-w.w/2,w.y-w.h/2,w.w,w.h);
    c.strokeStyle='rgba(137,235,240,.4)'; c.lineWidth=1.5;
    const len=Math.hypot(w.dx,w.dy)||1, dx=w.dx/len,dy=w.dy/len;
    for(let j=0;j<22;j++) {
      const x=w.x-w.w/2+((j*97+G.t*dx*75)%w.w+w.w)%w.w;
      const y=w.y-w.h/2+((j*137+G.t*dy*75)%w.h+w.h)%w.h;
      c.beginPath(); c.moveTo(x-dx*18,y-dy*18); c.lineTo(x,y);
      c.lineTo(x-dx*6-dy*4,y-dy*6+dx*4); c.moveTo(x,y);
      c.lineTo(x-dx*6+dy*4,y-dy*6-dx*4); c.stroke();
    }
  }
}

function render() {
  const c = ctx;
  c.setTransform(RS, 0, 0, RS, 0, 0);

  drawBackground(c);
  drawDust(c);

  c.save();
  // kamera: ruh üzerinde ortalı, artı sarsıntı ve küçük fırlatma itkisi
  const z = cam.zoom;
  c.translate(VW / 2 + cam.sx + cam.kx, VH / 2 + cam.sy + cam.ky);
  c.scale(z, z);
  c.translate(-cam.x, -cam.y);

  for (const e of world.lethal) if (inView(e)) drawLethal(c, e);
  for (const e of world.solids) if (inView(e)) drawSolid(c, e);
  for (const e of world.springs) if (inView(e)) drawSpring(c, e);
  for (const e of world.motes) if (inView(e)) drawMote(c, e);
  for (const e of world.nodes) if (inView(e, MOVE.nodeReach)) drawNode(c, e);
  drawEnvironment(c);
  drawGate(c, world.gate);

  drawReady(c);
  drawAim(c);
  const pose = Player.syncPose();
  if (Player.rig) Player.rig.sync(pose, c); else drawSpirit(c);
  drawParticles(c);
  if (DEV && devOverlay) drawDebug(c);

  c.restore();

  if (DEV && devOverlay) drawDebugHud(c);
  if (cam.flash > 0.01) {
    c.fillStyle = rgba(cam.flashCol, Math.min(0.5, cam.flash * 0.45));
    c.fillRect(0, 0, VW, VH);
  }
  if (G.fadeIn > 0) {
    c.fillStyle = `rgba(5,6,15,${clamp(G.fadeIn / 0.5, 0, 1) * 0.85})`;
    c.fillRect(0, 0, VW, VH);
  }
  drawTransition(c);
}

/* ============================================================
   9b. BÖLÜM TASARIMI HATA AYIKLAMA GÖRÜNÜMÜ  (yalnızca ?dev=1)
   ============================================================
   Bir bölümün ayarlanmaya ihtiyaç duyduğu her şey, bölümün kendisinin
   üzerine çizilir: simülasyonun gördüğü çarpışma kutuları, hareketli
   zeminin gerçekte izlediği yollar, bir yayın tetikleyici bölgesinin nerede
   başladığı ve hangi yöne fırlattığı, bir düğümün ne kadar uzaktan
   yakalayabildiği, her akıntının sınırları ve bölümün beyan ettiği rota —
   testlerin uçtuğu aynı konum noktaları.

   Buradaki hiçbir şey bir oyuncu için açık değildir. `DEV`, yalnızca açık
   bir ?dev=1 ile ayarlanır, kendi depolama anahtarında kalıcı olur ve
   ?dev=0 onu kaldırır.

     G   kaplamayı aç/kapat        H   beyan edilmiş rotayı aç/kapat
     ok tuşları   önceki / sonraki bölüm        R   yeniden başlat
     ?level=10&dev=1           doğrudan bir bölüme atla

   Okuma dışında, dünya uzayında, kamera dönüşümünün içinde çizilir. */
let devOverlay = true, devRoute = true;

function devBox(c, e, col, dash) {
  c.save();
  c.translate(e.x, e.y);
  if (e.a) c.rotate(e.a);
  c.strokeStyle = col; c.lineWidth = 1.5;
  if (dash) c.setLineDash(dash);
  c.strokeRect(-e.w / 2, -e.h / 2, e.w, e.h);
  c.restore();
}

function drawDebug(c) {
  c.save();
  c.setLineDash([]);

  // katılar: simülasyonun çarpıştığı kutular ve iniş kenarları
  for (const e of world.solids) {
    if (e.broken) continue;
    devBox(c, e, e.crumble ? 'rgba(255,170,120,.75)' : e.motion ? 'rgba(120,235,255,.75)' : 'rgba(120,255,180,.5)');
    if (!e.a) {
      c.strokeStyle = 'rgba(255,255,255,.55)'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(e.x - e.w / 2, e.y - e.h / 2); c.lineTo(e.x + e.w / 2, e.y - e.h / 2); c.stroke();
    }
    // hareketli zeminin tam seyahati, bir kutu artı iki uç konumu olarak
    if (e.motion && e.motion.type === 'osc') {
      const dx = e.motion.dx || 0, dy = e.motion.dy || 0;
      c.strokeStyle = 'rgba(120,235,255,.35)'; c.lineWidth = 1; c.setLineDash([6, 6]);
      c.strokeRect(e.bx - e.w / 2 - Math.abs(dx), e.by - e.h / 2 - Math.abs(dy),
                   e.w + Math.abs(dx) * 2, e.h + Math.abs(dy) * 2);
      c.beginPath(); c.moveTo(e.bx - dx, e.by - dy); c.lineTo(e.bx + dx, e.by + dy); c.stroke();
      c.setLineDash([]);
    }
  }

  // tehlikeler, gerçekten test edildikleri yarıçapta
  for (const e of world.lethal) {
    devBox(c, e, 'rgba(255,66,116,.85)');
    const k = e.k === undefined ? 1 : e.k;
    if (e.pulse) {
      c.fillStyle = k > 0.35 ? 'rgba(255,66,116,.9)' : 'rgba(255,66,116,.3)';
      c.fillRect(e.x - 3, e.y - e.h / 2 - 16, 6, 10);
    }
  }

  // yaylar: tetikleyici kutu ve fırlatmanın gerçekten gittiği yön
  for (const s of world.springs) {
    devBox(c, s, s.off ? 'rgba(140,140,140,.7)' : 'rgba(120,255,170,.9)');
    c.strokeStyle = 'rgba(120,255,170,.4)'; c.lineWidth = 1; c.setLineDash([4, 4]);
    c.strokeRect(s.x - s.w / 2 - MOVE.springExit, s.y - s.h / 2 - MOVE.springExit,
                 s.w + MOVE.springExit * 2, s.h + MOVE.springExit * 2);
    c.setLineDash([]);
    const nx = s.sa, ny = -s.ca;
    c.strokeStyle = '#7fffbe'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(s.x, s.y); c.lineTo(s.x + nx * 70, s.y + ny * 70); c.stroke();
  }

  // düğümler: oyuncunun gerçekten nişan aldığı hedef olan yakalama yarıçapı
  for (const n of world.nodes) {
    c.strokeStyle = n.cool > 0 ? 'rgba(140,140,140,.6)' : 'rgba(255,190,90,.8)';
    c.lineWidth = 1.5;
    c.beginPath(); c.arc(n.x, n.y, MOVE.nodeReach, 0, TAU); c.stroke();
  }

  // kontrol noktaları: parçacık ve bir yeniden doğuşun ruhu gerçekten koyduğu yer
  for (const m of world.motes) {
    c.strokeStyle = m.got ? 'rgba(200,160,255,.5)' : 'rgba(200,160,255,.9)';
    c.lineWidth = 1.5;
    c.beginPath(); c.arc(m.x, m.y, m.r, 0, TAU); c.stroke();
    c.beginPath(); c.arc(m.x, m.y - 26, 5, 0, TAU); c.stroke();
  }

  // akıntılar: sınırlar ve yön
  for (const w of world.winds) {
    c.strokeStyle = 'rgba(110,240,235,.7)'; c.lineWidth = 1.5;
    c.strokeRect(w.x - w.w / 2, w.y - w.h / 2, w.w, w.h);
    const len = Math.hypot(w.dx, w.dy) || 1;
    c.beginPath(); c.moveTo(w.x, w.y);
    c.lineTo(w.x + (w.dx / len) * 60, w.y + (w.dy / len) * 60); c.stroke();
  }

  // beyan edilmiş rota: erişilebilirlik testlerinin gerçekten uçtuğu şey
  const L = LEVELS[G.levelIndex];
  if (devRoute && L && L.route) {
    c.strokeStyle = 'rgba(255,255,255,.45)'; c.lineWidth = 2; c.setLineDash([9, 7]);
    c.beginPath();
    let started = false;
    for (const wp of L.route) {
      if (wp[2] === 'gate') { c.lineTo(world.gate.x, world.gate.y); break; }
      if (started) c.lineTo(wp[0], wp[1]); else { c.moveTo(wp[0], wp[1]); started = true; }
    }
    c.stroke(); c.setLineDash([]);
    for (const wp of L.route) {
      if (wp[2] === 'gate') continue;
      c.fillStyle = wp[2] === 'cling' ? '#9fd8ff' : wp[2] === 'node' ? '#ffbe5a'
        : wp[2] === 'spring' ? '#7fffbe' : '#ffffff';
      c.beginPath(); c.arc(wp[0], wp[1], 6, 0, TAU); c.fill();
    }
  }

  // ruhun kendi gövdesi ve nişan aldığı erişim
  c.strokeStyle = 'rgba(255,255,255,.8)'; c.lineWidth = 1.5;
  c.beginPath(); c.arc(body.x, body.y, body.r, 0, TAU); c.stroke();
  c.restore();
}

/* Okuma, ekran uzayında: neredeyiz ve dünya ne yapıyor. */
function drawDebugHud(c) {
  const L = LEVELS[G.levelIndex];
  const lines = [
    `L${G.levelIndex + 1}/${LEVELS.length} ${L ? L.name : ''}  world ${world.w}x${world.h}`,
    `spirit ${body.x.toFixed(0)},${body.y.toFixed(0)}  v ${body.vx.toFixed(1)},${body.vy.toFixed(1)}  ${PS.state}`,
    `cam ${cam.x.toFixed(0)},${cam.y.toFixed(0)}  zoom ${cam.zoom.toFixed(2)}  t ${G.t.toFixed(1)}s`,
    `spawn ${G.spawnX.toFixed(0)},${G.spawnY.toFixed(0)}  deaths ${G.deaths}  bursts ${G.bursts}`,
    Aim.on ? `aim ${(Aim.angle * 180 / Math.PI).toFixed(0)}deg  power ${Aim.power.toFixed(2)}` : 'G overlay · H route · arrows level · R restart',
  ];
  c.save();
  c.font = '11px ui-monospace, monospace';
  c.textAlign = 'left'; c.textBaseline = 'top';
  c.fillStyle = 'rgba(5,6,15,.62)';
  c.fillRect(8, 92, 330, lines.length * 14 + 10);
  c.fillStyle = '#cfe6ff';
  lines.forEach((t, i) => c.fillText(t, 14, 97 + i * 14));
  c.restore();
}

/* ---- rig arayüzü ----------------------------------------------------------
   Modellenmiş bir karakterin (büyük ihtimalle şeffaf bir katman üzerinde
   bir Three.js GLTF) simülasyona erişime ihtiyacı yoktur: kare başına bir
   poza ve bir durum adına ihtiyacı vardır. `Player.rig = { sync(pose, ctx)
   {...} }` atamak karakter çizimini devralır ve oyunda başka hiçbir şey
   değişmez. */
const Player = {
  body, rig: null,
  pose: {
    x: 0, y: 0, vx: 0, vy: 0, speed: 0, facing: 0, look: 0,
    state: 'spawn', aimable: false, grounded: false, clinging: false,
    clingSide: 0, squash: 0, squashAng: 0, stretch: 0, stretchAng: 0,
    scale: 1, flash: 0, aiming: false, aimAngle: 0, aimPower: 0,
  },
  syncPose() {
    const p = this.pose;
    p.x = body.x; p.y = body.y; p.vx = body.vx; p.vy = body.vy;
    p.speed = PS.speed; p.facing = PS.facing; p.look = Vis.lookT;
    p.state = PS.state; p.aimable = canAim();
    p.grounded = PS.state === 'ground'; p.clinging = PS.state === 'cling';
    p.clingSide = PS.clingSide;
    p.squash = Vis.squash; p.squashAng = Vis.squashAng;
    p.stretch = Vis.stretch; p.stretchAng = Vis.stretchAng;
    p.scale = Vis.scale; p.flash = Vis.flash;
    p.aiming = Aim.on; p.aimAngle = Aim.angle; p.aimPower = Aim.power;
    return p;
  },
};

/* ============================================================
   10. GİRDİ
   ============================================================
   Önce dokunma. Oyundaki her etkileşim aynı harekettir — bas, sürükle,
   bırak — ve basış ekranın herhangi bir yerine inebilir; bu yüzden
   vurulacak küçük bir hedef asla yoktur. Basışın NE ANLAMA GELDİĞİNE
   burada ve yalnızca burada karar verilir.
   ============================================================ */

/* ---- işaretçi -> sanal ekran ---------------------------------------------
   Nişan alma, dünya biriminde değil, SANAL EKRAN BİRİMİNDE — oyunun
   içinde bestelendiği sabit 540 x 960 kutuda — ölçülür.

   Bu, göründüğünden daha önemlidir. İşaretçiyi kamera üzerinden dönüştürmek,
   nişanı yakınlaştırmaya bağımlı kılıyordu; yakınlaştırma da nişana
   bağımlıydı: daha sert çek, görünüm uzaklaşır, aynı parmak konumu artık
   farklı bir dünya noktasına eşlenir, bu yüzden güç değişir, bu yüzden
   yakınlaştırma tekrar değişir. Kameranın yaptığı nefes alıp verme/pompalama
   buydu ve hiçbir miktarda yumuşatma böyle bir döngüyü düzeltemez — döngü
   kesilmelidir. Ekran-uzayı nişanı onu keser: kamera nişanı okur ve nişan
   kamerayı asla okumaz.

   Sabit bir sanal kutuda çalışmak, hareketin çözünürlükten bağımsız
   olmasını da sağlar: ekranın üçte biri boyunca aynı kaydırma, herhangi bir
   telefonda aynı sıçramadır. */
const gp = { x: 0, y: 0 };
function toScreen(e) {
  gp.x = (e.clientX - canvasRect.left) * (VW / canvasRect.width);
  gp.y = (e.clientY - canvasRect.top) * (VH / canvasRect.height);
  return gp;
}

let pointerId = null;
const buffered = { on: false, t: 0, id: null, sx: VW / 2, sy: VH / 2 };
function clearBuffer() { buffered.on = false; buffered.id = null; }

/* Sapan. GERİYE çekersin, gitmek istediğin yerin tersine, ve ruh, tersine
   uzanan bir elastiği germek gibi, karşıt vektör boyunca fırlar. Çekiş
   tamamen ekran-uzayındadır: `Aim.sx/sy`, parmağın bastığı yerdir ve geri
   kalan her şey o sabit noktadan olan farktan türetilir.

   `Aim.pull`, ham gerilmedir, kullanılabilir sürükleme mesafesinin 0..1'i;
   `Aim.power` ise oyunun kullandığı şeydir. Bilerek farklıdırlar —
   powerCurve'e bakın. */
function updateDrag(px, py) {
  const dx = px - Aim.sx, dy = py - Aim.sy;        // çekiş, ekran birimi
  const d = Math.hypot(dx, dy);
  Aim.px = px; Aim.py = py;
  Aim.pullLen = d;
  if (d <= MOVE.dragDead) { Aim.pull = 0; Aim.power = 0; Sfx.tensionUpdate(0); return; }
  Aim.pull = clamp((d - MOVE.dragDead) / (MOVE.dragFull - MOVE.dragDead), 0, 1);
  Aim.power = powerCurve(Aim.pull);
  Aim.angle = Math.atan2(-dy, -dx);                // fırlatma, çekişin aynadaki yansımasıdır
  Sfx.tensionUpdate(Aim.power);
}

function beginAim(sx, sy, id) {
  Aim.on = true;
  Aim.from = PS.state;
  Aim.sx = sx; Aim.sy = sy;
  Aim.px = sx; Aim.py = sy;
  Aim.held = 0;
  Aim.pull = 0; Aim.power = 0; Aim.pullLen = 0;
  Aim.angle = PS.state === 'cling' ? (PS.clingSide > 0 ? 0 : Math.PI) : -Math.PI / 2;
  lastPvx = NaN;
  pointerId = id;
  if (id !== null && id !== undefined && dom.canvas.setPointerCapture) {
    try { dom.canvas.setPointerCapture(id); } catch (err) {}
  }
  Sfx.tensionStart();
  setHint('');
}

/* Bir düğüme tutunmak. Ruhu YAKALAMA ANINDA çeker, oyuncu nişan alırken
   kademeli olarak değil: tutulan bir nişan altında sürüklenmeye devam eden
   bir karakter, tüm hareketi kaygan hissettirir ve yakalama zaten
   arkasında bir iz bırakan ani bir çekiliş olarak daha iyi okunur. */
function grabNode(n, px, py, id) {
  PS.node = n;
  PS.set('node');
  n.glow = 1;
  FX.spark(body.x, body.y, Math.atan2(n.y - body.y, n.x - body.x), 0.3,
           Math.hypot(n.x - body.x, n.y - body.y) / 9, 5, HUE.node.hi,
           { life: 0.3, size: 2.2, shape: 1, len: 16, drag: 0.82 });
  body.x = n.x; body.y = n.y;
  body.vx = 0; body.vy = 0; body.burst = 0;
  FX.shock(n.x, n.y, n.r * 2.2, n.r * 0.8, 0.3, HUE.node.rgb, 2);
  FX.spark(n.x, n.y, 0, Math.PI, 1.8, 6, HUE.node.hi, { life: 0.4, size: 2, drag: 0.9 });
  cam.punch = 0.035;
  Sfx.nodeCatch();
  beginAim(px, py, id);
}

function onDown(e) {
  if (G.menu) return;
  if (Aim.on || (e.button !== undefined && e.button !== 0)) return;
  if (buffered.on && e.pointerId !== buffered.id) return;
  Sfx.unlock();
  clearBuffer();
  if (G.phase === 'done') return;
  if (e.target === dom.restart || dom.restart.contains(e.target)) return;
  if (G.phase !== 'play') return;
  if (PS.state === 'hurt' || PS.state === 'spawn') return;

  canvasRect = dom.canvas.getBoundingClientRect();
  const p = toScreen(e);

  if (canAim()) {
    // Gerilme, parmağın bastığı yerden ölçülür; bu yüzden bir basış nereye
    // inerse insin her zaman sıfır güçle başlar ve oyuncu ister ruha ister
    // başka bir yere dokunsun, hareket aynıdır.
    beginAim(p.x, p.y, e.pointerId);
    e.preventDefault();
    return;
  }

  const n = nodeInReach();
  if (n) { grabNode(n, p.x, p.y, e.pointerId); e.preventDefault(); return; }

  // Henüz üzerinde hareket edilecek bir şey yok. Basışı kısa süre tut: eğer
  // bir duvar, zemin ya da düğüm bekleme penceresi içinde gelirse, kaybolmak
  // yerine orada harcanır.
  if (PS.state === 'air') {
    buffered.on = true; buffered.t = 0; buffered.id = e.pointerId;
    buffered.sx = p.x; buffered.sy = p.y;
    e.preventDefault();
    return;
  }
  G.deny = 1;
}

/* Bir şey cevap verebildiği anda tutulan basışı harca. */
function updateAimBuffer() {
  if (!buffered.on) return;
  buffered.t += STEP;
  if (G.phase !== 'play' || PS.state === 'hurt' || PS.state === 'spawn') { clearBuffer(); return; }
  if (canAim()) {
    const id = buffered.id, sx = buffered.sx, sy = buffered.sy;
    clearBuffer();
    beginAim(sx, sy, id);          // gerilme, parmağın olduğu yerden yeniden başlar
    return;
  }
  const n = nodeInReach();
  if (n) {
    const id = buffered.id, sx = buffered.sx, sy = buffered.sy;
    clearBuffer(); grabNode(n, sx, sy, id); return;
  }
  if (buffered.t >= MOVE.buffer) { clearBuffer(); G.deny = 1; }
}

function onMove(e) {
  if (buffered.on && e.pointerId === buffered.id) { e.preventDefault(); return; }
  if (!Aim.on || (pointerId !== null && e.pointerId !== pointerId)) return;
  const p = toScreen(e);
  updateDrag(p.x, p.y);
  e.preventDefault();
}

function onUp(e) {
  if (buffered.on && e.pointerId === buffered.id) { clearBuffer(); e.preventDefault(); return; }
  if (!Aim.on || (pointerId !== null && e.pointerId !== pointerId)) return;
  // Ölü bölge TEK iptal kuralıdır. Bırakışı güç değeri üzerinden
  // değerlendirmek, ölü bölgenin hemen ötesindeki bir çekişin sıfıra yakın
  // bir güç üretip sessizce çöpe atılması anlamına gelirdi — oyuncu açıkça
  // küçük bir sıçrama istemiş ve hiçbir şey alamamış olurdu.
  const launched = Aim.pullLen > MOVE.dragDead;
  const p = Aim.power, a = Aim.angle;
  const ok = canAim();
  Aim.on = false;
  pointerId = null;
  Sfx.tensionStop();
  if (launched && ok) doBurst(a, p);
  else if (PS.state === 'node') { PS.node.cool = 0.5; PS.node = null; PS.set('air'); }
  Aim.power = 0; Aim.pull = 0; Aim.pullLen = 0;
  endGesture();
  e.preventDefault();
}

function endGesture() {
  if (fitPending) fit();
}

function cancelAim() {
  if (PS.state === 'node' && PS.node) { PS.node.cool = 0.5; PS.node = null; PS.set('air'); }
  Aim.clear();
  pointerId = null;
  clearBuffer();
  lastPvx = NaN;
  Sfx.tensionStop();
  endGesture();
}

dom.canvas.addEventListener('pointerdown', onDown, { passive: false });
window.addEventListener('pointermove', onMove, { passive: false });
window.addEventListener('pointerup', onUp, { passive: false });
window.addEventListener('pointercancel', cancelAim);
/* Bilerek `lostpointercapture` üzerinde iptal edilmiyor. Yakalama bir
   kolaylıktır ve onu kaybetmek oyuncunun bıraktığı anlamına gelmez —
   tarayıcı, canvas arka belleği her yeniden atandığında bunu düşürür ve bu
   oyun, uyarlanabilir kalite seviyesi her değiştiğinde ya da pencere yeniden
   boyutlandırıldığında bunu kendiliğinden yapar. Bu, yavaş bir kareyi
   sessizce ölü bir harekete çeviriyordu. `pointerup` ve `pointercancel`,
   hareketin gerçekten bittiği anlamına gelen olaylardır ve ikisi de
   `window` üzerinde işlenir; bu yüzden yakalama olsun ya da olmasın gelirler. */
window.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());
window.addEventListener('touchmove', (e) => { if (!G.menu && e.cancelable) e.preventDefault(); }, { passive: false });

dom.restart.addEventListener('click', (e) => { e.stopPropagation(); Sfx.unlock(); restartLevel(); });

let muted = false;
function applyMute(v) {
  muted = v;
  Sfx.setMuted(v);
  dom.sound.classList.toggle('muted', v);
  dom.sound.setAttribute('aria-pressed', String(!v));
  Store.set('muted', v ? '1' : '0');
}
dom.sound.addEventListener('click', (e) => {
  e.stopPropagation(); applyMute(!muted); Sfx.unlock(); if (!muted) Sfx.ui();
});
dom.endRestart.addEventListener('click', () => { Sfx.unlock(); Sfx.ui(); restartRun(); });


function selectLevel(i) {
  if (!Number.isInteger(i) || i<0 || i>Save.unlocked()) return false;
  cancelAim(); G.transDir=0; G.transNext=null; doneFrames=0;
  Sfx.unlock(); Sfx.ui(); startLevel(i); return true;
}
function showMenu(select) {
  cancelAim(); G.menu=true; Sfx.environment(false);
  document.getElementById('ui').inert = true;
  dom.endCard.inert = true;
  const card=document.getElementById('menuCard'); card.classList.remove('hidden');
  document.getElementById('menuStart').textContent=Save.unlocked()>0?'DEVAM ET':'BAŞLA';
  document.getElementById('levelGrid').classList.toggle('hidden',!select);
  document.getElementById('menuBack').classList.toggle('hidden',!select);
  for(let i=0;i<LEVELS.length;i++) {
    const b=document.getElementById('chooseLevel'+i);
    b.disabled=i>Save.unlocked();
    b.textContent='BÖLÜM '+(i+1)+(b.disabled?' · Kilitli':Save.completed(i)?' · ✓':'');
    b.setAttribute('aria-label','Bölüm '+(i+1)+': '+LEVELS[i].name+(b.disabled?' · Kilitli':''));
  }
}
for(let i=0;i<LEVELS.length;i++) {
  const b=document.createElement('button'); b.id='chooseLevel'+i; b.type='button';
  b.addEventListener('click',()=>selectLevel(i)); document.getElementById('levelGrid').appendChild(b);
}
document.getElementById('menuStart').addEventListener('click',()=>selectLevel(Save.unlocked()));
document.getElementById('menuLevels').addEventListener('click',()=>showMenu(true));
document.getElementById('endSelect').addEventListener('click',()=>showMenu(true));
document.getElementById('levelsBtn').addEventListener('click',()=>showMenu(true));
document.getElementById('menuBack').addEventListener('click',()=>{
  G.menu=false;
  document.getElementById('menuCard').classList.add('hidden');
  document.getElementById('ui').inert=false;
  dom.endCard.inert=false;
});

const DEV = (() => {
  if (/[?&]dev=1/.test(location.search)) { Store.set('dev', '1'); return true; }
  if (/[?&]dev=0/.test(location.search)) { Store.del('dev'); return false; }
  return Store.get('dev') === '1';
})();

window.addEventListener('keydown', (e) => {
  if (!G.menu && (e.key === 'r' || e.key === 'R')) restartLevel();
  if (e.key === 'm' || e.key === 'M') { applyMute(!muted); Sfx.unlock(); }
  if (DEV && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
    e.preventDefault();
    cancelAim();
    G.transDir = 0;
    startLevel(clamp(G.levelIndex + (e.key === 'ArrowRight' ? 1 : -1), 0, LEVELS.length - 1));
  }
  if (DEV && (e.key === 'f' || e.key === 'F')) {
    fpsOn = !fpsOn;
    dom.fps.classList.toggle('hidden', !fpsOn);
    fpsFrames = 0; fpsSince = performance.now();
  }
  if (DEV && (e.key === 'g' || e.key === 'G')) devOverlay = !devOverlay;
  if (DEV && (e.key === 'h' || e.key === 'H')) devRoute = !devRoute;
});

window.addEventListener('resize', fit);
window.addEventListener('orientationchange', () => setTimeout(fit, 120));
if (window.visualViewport) window.visualViewport.addEventListener('resize', fit);
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fit).observe(dom.canvas);

/* ============================================================
   11. ANA DÖNGÜ
   ============================================================ */

const DT_MAX = 1 / 15;

let last = 0, acc = 0, frameCount = 0, doneFrames = 0;
let fpsOn = false, fpsFrames = 0, fpsSince = 0;
let frameId = 0;

function frame(now) {
  frameId = requestAnimationFrame(frame);
  if (document.hidden) return;
  if (G.phase === 'done' && G.transDir === 0 && doneFrames >= 3) { last = now; acc = 0; return; }
  if (!last) last = now;
  const rawDt = (now - last) / 1000;
  let dt = rawDt;
  last = now;
  const workStart = performance.now();

  if (dt > DT_MAX) dt = DT_MAX;
  acc += dt;
  let guard = 0;
  while (acc >= STEP && guard < 4) { simStep(); acc -= STEP; guard++; }
  if (acc > STEP) acc = 0;

  if (rawDt > 0 && rawDt < 0.25) Q.avg += (rawDt * 1000 - Q.avg) * 0.08;
  if (!guard) return;
  frameCount++;
  render();
  if (G.phase === 'done' && G.transDir === 0) doneFrames++;
  Q.work += (performance.now() - workStart - Q.work) * 0.08;

  if (Q.level === 1) {
    if (Q.avg > 21 || Q.work > 14) { if (++Q.bad > 40) { Q.level = 0; Q.particleScale = 0.55; Q.bad = 0; fit(); } }
    else Q.bad = 0;
  } else {
    if (Q.avg < 18 && Q.work < 7) { if (++Q.good > 480) { Q.level = 1; Q.particleScale = 1; Q.good = 0; fit(); } }
    else Q.good = 0;
  }

  if (fpsOn) {
    fpsFrames++;
    if (now - fpsSince >= 500) {
      const f = Math.round(fpsFrames * 1000 / (now - fpsSince));
      dom.fps.textContent = f + ' FPS · ' + Q.avg.toFixed(1) + ' ms · ' + PS.state;
      fpsFrames = 0; fpsSince = now;
    }
  }
}

document.addEventListener('visibilitychange', () => {
  Sfx.suspend(document.hidden);
  cancelAnimationFrame(frameId);
  cancelAim();
  last = 0; acc = 0;
  Q.bad = 0; Q.good = 0;
  fpsFrames = 0; fpsSince = performance.now();
  if (!document.hidden) { fit(); frameId = requestAnimationFrame(frame); }
});

if (Store.get('muted') === '1') applyMute(true);
if (DEV) { fpsOn = true; dom.fps.classList.remove('hidden'); }

/* Sayfa kendi başına ne bir ad ne de etiket taşır; ilk kare çizilmeden
   önce ikisini de burada alır. */
applyBranding();

/* Oyuncunun bıraktığı yerden devam et. İlerleme her zaman yalnızca bir
   İNDEKS'tir — bölümün kendisi, tıpkı bir yeniden başlatmanın kuracağı
   gibi, verisinden yeniden kurulur; böylece devam etmek ve yeniden
   başlatmak aynı yere varır. */
Save.load();
/* ?level=N bir bölüme, onu oynamadan ayarlamak için, doğrudan atlar.
   Yalnızca geliştirici modunda: ?dev=1 olmadan yok sayılır, bu yüzden
   paylaşılan bir bağlantı hiçbir şeyin kilidini açamaz. */
const devJump = DEV && /[?&]level=(\d+)/.exec(location.search);
const resumeAt = devJump ? clamp(Number(devJump[1]) - 1, 0, LEVELS.length - 1) : Save.unlocked();
startLevel(resumeAt);
showMenu(false);
fit();
frameId = requestAnimationFrame(frame);

/* ---- hata ayıklama / otomasyon yüzeyi ---- */
/* Yalnızca dahili — asla oyuncuya görünmez, bu yüzden bilerek GAME.title'ı
   takip etmez: oyunu yeniden adlandırmak, yer imli bir konsol çağrısını ya
   da test altyapısını asla bozmamalıdır. */
window.FLUX = {
  G, body, PS, Vis, Aim, world, LEVELS, MOVE, Q, Player, cam, Save, Store, TEXT, GAME, selectLevel, showMenu,
  go: (i) => startLevel(clamp(i | 0, 0, LEVELS.length - 1)),
  burst: (ang, power) => { if (canAim()) doBurst(ang, clamp(power, 0, 1)); },
  tick: (n) => { for (let i = 0; i < n; i++) simStep(); },
  state: () => PS.state,
  aimable: () => canAim(),
  mute: (v) => { muted = !!v; Sfx.setMuted(muted); },
  wipe: () => { Save.reset(); startLevel(0); },
  bench: (n) => {
    n = n || 120;
    render();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) render();
    const ms = (performance.now() - t0) / n;
    return { frameMs: +ms.toFixed(3), budgetPct: +(ms / 16.67 * 100).toFixed(1) };
  },
};


})();
