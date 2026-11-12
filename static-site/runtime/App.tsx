import type {PublicCatalogProduct} from '../../lib/catalog/types.ts';
import type {PhotoIndex} from '../lib/photo-shard.ts';
import type {CatalogCard} from '../lib/card-shard.ts';
import type {GiftGuideDefinition} from '../../lib/gift-guide-definitions.ts';
import {privacyPolicySections,privacyPolicyIntro,privacyPolicyUpdated} from '../../lib/privacy-policy.ts';
import {PUBLIC_CONTACT_EMAIL} from '../../lib/site.ts';
import {ProductCard} from '../components/ProductCard.tsx';
import {CatalogPhotos,CatalogImage,CatalogDescription,CatalogDisclosure} from '../components/CatalogPhotos.tsx';
import {Search} from '../components/Search.tsx';
import {CatalogFeed} from '../components/CatalogFeed.tsx';
import {RandomSelection} from '../components/RandomSelection.tsx';
import {ShowLineup} from '../components/ShowLineup.tsx';
import {StaticAnalytics} from '../components/StaticAnalytics.tsx';
import {Icon} from '../components/Icon.tsx';
import {useEffect,useState} from 'react';
import {catalogDeadline} from '../../lib/catalog/display.ts';
import {shortProductName} from '../lib/product-presentation.ts';

export interface RuntimePageProps {
  kind:'home'|'show'|'howie'|'product'|'held'|'random'|'guides'|'guide'|'privacy'|'missing';
  products:PublicCatalogProduct[];cards:CatalogCard[];related?:PublicCatalogProduct[];
  catalogRevision:string;version:string;next:string|null;poolSize:number;
  action:string;guide?:GiftGuideDefinition;guides:Array<Pick<GiftGuideDefinition,'slug'|'title'|'intro'>>;
  analytics:boolean;disclosures:Record<string,string>;
  photoIndex:string|null;photoSlots:string[];initialPhotoIndex?:PhotoIndex;eligibleUntil:string|null;
}
function Chrome({children,analytics}:{children:React.ReactNode;analytics:boolean}){
  return <>{analytics&&<StaticAnalytics/>}<a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header"><a className="wordmark" href="/" aria-label="Stupid Gifts home">stupid<span>.</span>gifts</a>
      <nav aria-label="Main navigation"><a className="nav-random" href="/random-gift"><Icon name="dice"/>Surprise me</a>
        <a className="nav-secondary" href="/gift-guides">Gift guides</a><a href="/#catalog-search" className="nav-search">Search</a></nav></header>
    {children}<footer><a className="wordmark" href="/">stupid<span>.</span>gifts</a>
      <p className="quiet">We may earn a commission. As an Amazon Associate we earn from qualifying purchases.</p>
      <p className="footer-partner"><a href={`mailto:${PUBLIC_CONTACT_EMAIL}?subject=Stupid%20Gifts%20partnership`}>Selling something stupid? Partner with us!</a></p>
      <div className="footer-bottom"><span>© Thirty Seven Inc.</span><a href="/gift-guides">Gift guides</a><a href="/random-gift">Surprise me</a>
        <a href="https://www.pinterest.com/stupid_gifts/" target="_blank" rel="noopener noreferrer">Pinterest<span className="sr-only"> (opens in a new tab)</span></a>
        <a href={`mailto:${PUBLIC_CONTACT_EMAIL}`}>Contact</a><a href="/privacy">Privacy</a></div></footer></>;
}
function Grid({products,show=false}:{products:PublicCatalogProduct[];show?:boolean}){
  return <div className="catalog-grid" aria-label="Gifts">{products.map((p,index)=><ProductCard key={p.publicId} product={p}
    lead={show&&index===0} eager={show} context={show?'show-curated':'catalog'}/>)}</div>;
}
function Detail({product,related=[]}:{product:PublicCatalogProduct;related?:PublicCatalogProduct[]}){
  const retailer=product.source==='amazon'?'Amazon':'Etsy';
  return <><a className="back-link" href="/">Browse all gifts</a><article className="product-detail">
    <div className="detail-art retailer-art"><CatalogImage id={product.id} imageUrl={product.imageUrl} alt={product.title} className="object-contain" sizes="(max-width: 700px) 90vw, 55vw" priority/></div>
    <div className="detail-copy"><h1>{shortProductName(product.title)}</h1><CatalogDisclosure source={product.source} id={product.id}/>
      <CatalogDescription source={product.source} id={product.id} title={product.title} fallback={product.description}/>
      <div id="gift-retailer-primary" data-analytics-id={product.id} data-analytics-source={product.source} data-analytics-context="gift_page_primary_cta"
        data-analytics-expiry={product.eligibleUntil??undefined} data-analytics-permanent={product.eligibleUntil===null?'':undefined}>
        <a data-analytics-outbound="" href={product.affiliateUrl} target="_blank" rel="sponsored noopener noreferrer" className="button">Check price on {retailer}<Icon name="external"/><span className="sr-only"> (opens in a new tab)</span></a>
        <p className="quiet">Check current price and availability at the retailer. We may earn a commission.</p></div>
      {product.editorialWriteup&&<details className="editorial"><summary>More about this gift</summary>{product.editorialWriteup.split(/\n\s*\n/).map((p,i)=><p key={i}>{p}</p>)}</details>}
    </div></article>{related.length>0&&<section className="section-block"><div className="section-heading"><h2>You might also like</h2><a href="/random-gift" className="text-action">Surprise me</a></div><Grid products={related}/></section>}</>;
}
export function RuntimeApp(props:RuntimePageProps){
  let content:React.ReactNode;
  if(props.kind==='home'||props.kind==='show')content=<><div className="opening-line"><h1>Stupid gifts. <span>Excellent taste.</span></h1></div>
    <Search action={props.action as '/'} autoSearch={props.kind!=='show'}>{props.kind==='show'
      ?<ShowLineup catalogRevision={props.catalogRevision} action={props.action}><Grid products={props.products} show/></ShowLineup>
      :<><CatalogFeed initial={props.cards} next={props.next} catalogRevision={props.catalogRevision} version={props.version}/>
        <section className="section-block"><div className="section-heading"><h2>Gift guides</h2><a className="text-action" href="/gift-guides">All guides</a></div>
          <div className="guide-links">{props.guides.slice(0,2).map(g=><a key={g.slug} href={`/gift-guides/${g.slug}`}>{g.title}<Icon name="chevron"/></a>)}
            <a href="/random-gift"><Icon name="dice" className="guide-icon"/>Surprise me<Icon name="chevron"/></a></div></section></>}
    </Search></>;
  else if(props.kind==='product')content=<Detail product={props.products[0]} related={props.related}/>;
  else if(props.kind==='random')content=<><div className="page-heading"><h1>Something stupid, just for you.</h1></div>
    <RandomSelection initial={props.cards[0]} poolSize={props.poolSize} poolPath={`/catalog/${props.version}/random.json`} catalogRevision={props.catalogRevision} version={props.version}/></>;
  else if(props.kind==='guide'&&props.guide)content=<><a className="back-link" href="/gift-guides">← Gift guides</a>
    <div className="page-heading"><p className="eyebrow">Gift guides</p><h1>{props.guide.h1}</h1><p>{props.guide.intro}</p></div>
    <section className="guide-selection"><div className="section-heading"><h2>Gift ideas</h2><span className="quiet">{props.products.length} selections</span></div>
      {props.products.length?<Grid products={props.products}/>:<p>No matching gifts yet. <a href="/">Browse all gifts.</a></p>}</section>
    {props.guide.editorialSections?.map(s=><section className="section-block" key={s.title}><h2>{s.title}</h2>{s.paragraphs.map(p=><p key={p}>{p}</p>)}
      {s.links?.map(link=><a className="text-action" key={link.slug} href={`/gift-guides/${link.slug}`}>{link.label}</a>)}</section>)}
    {Boolean(props.guide.faqs?.length)&&<section className="section-block"><h2>What to know before picking one.</h2>{props.guide.faqs?.map(faq=><article key={faq.question}><h3>{faq.question}</h3><p>{faq.answer}</p></article>)}</section>}
    <section className="section-block"><h2>Keep browsing.</h2><div className="related-guide-links">{props.guides.filter(g=>g.slug!==props.guide?.slug).slice(0,8).map(g=><a key={g.slug} href={`/gift-guides/${g.slug}`}>{g.title}</a>)}</div></section></>;
  else if(props.kind==='guides')content=<><div className="page-heading"><p className="eyebrow">Gift guides</p><h1>Find the right kind of stupid.</h1></div>
    <div className="guide-links">{props.guides.map(g=><a key={g.slug} href={`/gift-guides/${g.slug}`}><span>{g.title}<small>{g.intro}</small></span><Icon name="chevron"/></a>)}</div></>;
  else if(props.kind==='privacy')content=<div className="prose"><h1>Privacy Policy</h1><p className="quiet">Last updated {privacyPolicyUpdated}</p><p>{privacyPolicyIntro.replaceAll('goose.gifts','stupid.gifts')}</p>
    {privacyPolicySections.map(s=><section key={s.title}><h2>{s.title}</h2>{s.body.map(p=><p key={p}>{p.replaceAll('goose.gifts','stupid.gifts')}</p>)}</section>)}</div>;
  else if(props.kind==='howie')content=<div className="page-heading"><p className="eyebrow">From the show</p><h1>Nothing to announce. Yet.</h1>
    <p>No episode selection has been published. When there is a confirmed selection, you’ll find the exact products here.</p><a className="button" href="/">Browse gifts</a></div>;
  else content=<div className="page-heading"><h1>{props.kind==='held'?'Gift currently unavailable.':'That gift wandered off.'}</h1><p>{props.kind==='held'?'This gift is not currently available in the curated catalog.':'We couldn’t find that page.'}</p><a className="button" href="/">Browse all gifts</a></div>;
  return <Chrome analytics={props.analytics}><CatalogPhotos indexPath={props.photoIndex} photoSlots={props.photoSlots} initialIndex={props.initialPhotoIndex} editorialDisclosures={props.disclosures}>
    <Expiry until={props.eligibleUntil}><main id="main" className={`site-main${props.kind==='guide'?' guide-detail':''}`}>{content}</main></Expiry></CatalogPhotos></Chrome>;
}
function Expiry({until,children}:{until:string|null;children:React.ReactNode}){
  const [expired,setExpired]=useState(false);
  useEffect(()=>{const deadline=catalogDeadline(until);if(!Number.isFinite(deadline))return;
    const check=()=>{if(deadline<=Date.now())setExpired(true);};check();
    const timer=window.setTimeout(check,Math.max(0,Math.min(2_147_483_647,deadline-Date.now())));
    window.addEventListener('pageshow',check);document.addEventListener('visibilitychange',check);
    return()=>{window.clearTimeout(timer);window.removeEventListener('pageshow',check);document.removeEventListener('visibilitychange',check);};
  },[until]);
  return expired?<main id="main" className="site-main"><div className="page-heading"><h1>These gifts need a fresh look.</h1><p>This saved page has expired. <a href="/">Browse the current gifts.</a></p></div></main>:children;
}
