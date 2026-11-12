'use client';

import { useState } from 'react';
import { cleanAmazonImageUrl } from '@/lib/image-utils';

interface ProductImageProps {
  imageUrl: string;
  alt: string;
  className?: string;
  sizes?: string;
  priority?: boolean;
  placeholder?: 'loading' | 'unavailable';
}

export function ProductImage(props: ProductImageProps) {
  const { imageUrl } = props;
  const normalizedImageUrl = imageUrl.includes('media-amazon.com')
    ? cleanAmazonImageUrl(imageUrl)
    : imageUrl;

  return <ImageContent key={normalizedImageUrl} {...props} imageUrl={normalizedImageUrl} />;
}

function ImageContent({ imageUrl, alt, className = '', sizes, priority = false, placeholder }: ProductImageProps) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const unavailable = placeholder === 'unavailable' || !imageUrl || status === 'error';
  const loading = !unavailable && (placeholder === 'loading' || status === 'loading');

  return (
    <div className="product-image-frame" aria-busy={loading}>
      {(loading || unavailable) && (
        <span className="product-image-feedback" role="img" aria-label={loading ? 'Loading photo' : 'Photo unavailable'}>
          {loading ? <span className="product-image-spinner" aria-hidden="true" />
            : <span className="product-image-unavailable" aria-hidden="true">Photo unavailable</span>}
        </span>
      )}
      {!placeholder && !unavailable && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt={alt}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
          className={`${className} product-image-image ${status === 'loaded' ? 'product-image-loaded' : ''}`}
          sizes={sizes}
          loading={priority ? 'eager' : 'lazy'}
          fetchPriority={priority ? 'high' : 'auto'}
          decoding="async"
          ref={image => {
            if (image?.complete) setStatus(image.naturalWidth > 0 ? 'loaded' : 'error');
          }}
          onLoad={() => setStatus('loaded')}
          onError={() => setStatus('error')}
        />
      )}
    </div>
  );
}
