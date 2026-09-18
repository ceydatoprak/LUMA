# ✦ LUMA

HTML, CSS ve JavaScript ile geliştirilmiş, fizik tabanlı mobil platform ve beceri oyunu prototipi.

Oyuncu, ışık benzeri bir karakteri yönlendirerek 15 farklı bölüm boyunca platformlar, hareketli engeller ve çevresel mekaniklerle ilerler. Bölümler ilerledikçe yeni mekanikler eklenir ve mevcut sistemler birlikte kullanılmaya başlanır.

## Özellikler

- 15 farklı bölüm
- Fizik tabanlı hareket sistemi
- Duvara tutunma mekaniği
- Enerji noktaları
- Yay ve sıçrama mekanikleri
- Hareketli platformlar
- Kırılabilen platformlar
- Rüzgâr akımları
- Zamanlamaya dayalı ışın engelleri
- Checkpoint sistemi
- Bölüm seçme ekranı
- Mobil uyumlu arayüz
- Ses efektleri
- İlerleme kaydı

## Oynanış

Her bölüm oyuncuya yeni bir mekanik tanıtır ve ilerleyen bölümlerde bu mekanikler birlikte kullanılmaya başlanır.

Oyunun zorluğu yalnızca daha uzun atlayışlardan değil; zamanlama, doğru rota seçimi, hareketli platformları kullanma ve farklı çevresel mekanikleri bir arada yönetme üzerine kuruludur.

Son bölümlerde önceki bölümlerde öğrenilen mekanikler daha uzun ve karmaşık parkurlarda bir araya gelir.

## Kullanılan Teknolojiler

- HTML5
- CSS3
- JavaScript
- Canvas API
- Web Audio API
- Node.js
- Git / GitHub

## Test ve Geliştirme

Projede bölüm tasarımını ve hareket sistemini kontrol etmek için otomatik testler bulunmaktadır.

Testler;

- bölüm geçilebilirliğini,
- hareket mesafelerini,
- platform ve engel yerleşimlerini,
- checkpoint güvenliğini,
- bazı oynanış rotalarını

kontrol etmek için kullanılmıştır.

## Proje Yapısı

- `index.html` — Oyun arayüzü
- `style.css` — Görsel tasarım ve responsive yapı
- `game.js` — Oyun mekaniği, fizik sistemi ve bölümler
- `tests/` — Oyun ve bölüm doğrulama testleri
- `package.json` — Test ve geliştirme komutları

## Not

Bu proje oyun geliştirme stajım sırasında geliştirdiğim mobil oyun prototiplerinden biridir.

Proje boyunca fizik tabanlı oyun mekaniği, bölüm tasarımı, mobil kullanıcı deneyimi ve otomatik test süreçleri üzerinde çalışılmıştır.
