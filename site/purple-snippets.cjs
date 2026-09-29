module.exports = ({data, esc, img, gumroadSlug}) => {
  const gameMosaic = () => {
    const picks = data.games.filter(game => game.img).slice(0, 3);
    return `<div class="kl-game-mosaic" aria-label="Kuro Labs games">${picks.map((game, index) => `<figure class="kl-game-tile kl-game-tile-${index + 1}">${img(game.img.split('/').pop(), game.title)}<figcaption>0${index + 1} / ${esc(game.title)}</figcaption></figure>`).join('')}<span class="kl-mosaic-reticle" aria-hidden="true"></span></div>`;
  };

  const projectSystem = () => `<div class="kl-system-map"><div class="kl-system-head"><span>KURO / SYSTEM MAP</span><b>${String(data.projects.length).padStart(2, '0')} MODULES</b></div>${data.projects.slice(0, 4).map((project, index) => `<div class="kl-system-row"><span>${['AI CORE','SERVICE','PIPELINE','SYSTEM'][index]}</span><strong>${esc(project.name)}</strong><i>${esc(project.status)}</i></div>`).join('')}<span class="kl-signal-line" aria-hidden="true"></span></div>`;

  const shopShowpiece = () => {
    const product = data.products[0];
    const slug = gumroadSlug(product.buy);
    return `<a class="kl-shop-showpiece" href="/shop/${esc(product.slug)}/"><img src="${esc(product.img)}" alt="${esc(product.name)}"><span class="kl-showpiece-view">VIEW ASSET ↗</span><div><small>FEATURED / 01</small><strong>${esc(product.name)}</strong><em>${esc(product.tag || product.specs[0][1])} · ${esc(product.price)}</em>${slug ? `<span class="kl-showpiece-sold" data-sold-slug="${esc(slug)}" hidden></span>` : ''}</div></a>`;
  };

  const commissionBlueprint = () => `<div class="kl-blueprint"><div class="kl-blueprint-head"><span>BUILD CAPABILITY</span><b>04 DISCIPLINES</b></div>${[['01','&lt;/&gt;','SOFTWARE / AI'],['02','◇','3D / VR'],['03','▱','WEB SYSTEMS'],['04','＋','GAMES']].map(item => `<div><span>${item[0]}</span><strong>${item[1]}</strong><small>${item[2]}</small></div>`).join('')}<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M25 25H75V75H25ZM25 25 75 75M75 25 25 75"/></svg></div>`;

  const contactConsole = () => `<div class="kl-contact-console"><div class="kl-console-head"><span>DIRECT CHANNEL</span><b>AVAILABLE</b></div><p>DISCORD USER</p><strong>kuro701</strong><small>Include your idea, target platform, references and deadline if you have one.</small><div class="kl-console-links"><a href="https://instagram.com/6kuro_labs9" target="_blank" rel="noopener noreferrer">IG ↗</a><a href="https://youtube.com/@KuroLab701" target="_blank" rel="noopener noreferrer">YT ↗</a><a href="https://github.com/Kuro701" target="_blank" rel="noopener noreferrer">GH ↗</a><a href="https://rajcu.gumroad.com/" target="_blank" rel="noopener noreferrer">STORE ↗</a></div></div>`;

  return {gameMosaic, projectSystem, shopShowpiece, commissionBlueprint, contactConsole};
};
