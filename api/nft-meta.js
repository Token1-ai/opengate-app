/**
 * OpenGate NFT Metadata endpoint — api/nft-meta.js
 *
 * Навіщо: гаманці (MetaMask, Trust Wallet, bscscan) не показують картинку
 * Gold/Silver Pass, бо контракти пропусків (ERC-721) досі не мають робочого
 * tokenURI — baseURI або порожній, або вказує в нікуди.
 *
 * Це рішення — ОДИН ендпоінт на всі токени обох колекцій. Усі пропуски
 * одного рівня виглядають однаково (це членський пропуск, а не унікальний
 * арт), тому не треба 3000+5000 окремих файлів метаданих — досить одного
 * маленького серверлес-файлу.
 *
 * Як підʼєднати (без зміни контрактів — там уже є setBaseURI):
 *   1. Залити цей файл як api/nft-meta.js (Vercel підхопить автоматично).
 *   2. Залити gold-pass.png і silver-pass.png в корінь репо (поряд з index.html).
 *   3. На bscscan → кожен контракт (GoldPass і SilverPass) окремо →
 *      Write Contract → підключити гаманець-власника → setBaseURI:
 *        GoldPass:   https://opengate.bond/api/nft-meta?tier=gold&id=
 *        SilverPass: https://opengate.bond/api/nft-meta?tier=silver&id=
 *      (ERC-721 сам доклеює номер токена в кінець рядка — тому саме так,
 *       без слеша в кінці і без лапок навколо.)
 *
 * Після цього гаманці і bscscan почнуть показувати картинку для всіх
 * токенів одразу — оновлення й перевипуску контрактів не треба.
 */
module.exports = function handler(req, res) {
  const tier = String(req.query.tier || '').toLowerCase();
  const id = String(req.query.id || '0');

  const TIERS = {
    gold: {
      name: 'OpenGate Gold Pass',
      description: 'VIP membership pass for OpenGate — grants 2x GATE rewards, unlimited posts with images, VIP Gold Battleship access, and free token creation on mainnet.',
      image: 'https://opengate.bond/gold-pass.png',
      trait: 'Gold'
    },
    silver: {
      name: 'OpenGate Silver Pass',
      description: 'Membership pass for OpenGate — grants 1.3x GATE rewards, unlimited posts with images, and early access to new features.',
      image: 'https://opengate.bond/silver-pass.png',
      trait: 'Silver'
    }
  };

  const t = TIERS[tier];
  if (!t) {
    res.status(404).json({ error: 'Unknown tier. Use ?tier=gold or ?tier=silver' });
    return;
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.status(200).json({
    name: `${t.name} #${id}`,
    description: t.description,
    image: t.image,
    external_url: 'https://opengate.bond',
    attributes: [
      { trait_type: 'Tier', value: t.trait },
      { trait_type: 'Platform', value: 'OpenGate' }
    ]
  });
};
