export const detectBrowser = () => {
  if (typeof window === 'undefined') return null;
  
  const userAgent = window.navigator.userAgent;
  
  const isSafari = /^((?!chrome|android).)*safari/i.test(userAgent);
  const isIOS = /iPad|iPhone|iPod/.test(userAgent);
  const isMobile = /Mobi|Android/i.test(userAgent) || isIOS;
  
  return {
    isSafari,
    isIOS,
    isMobile,
    isSafariMobile: isSafari && isMobile,
    isSafariIOS: isSafari && isIOS
  };
};

export const useBrowserClass = () => {
  const browser = detectBrowser();
  if (!browser) return '';
  
  const classes = [];
  if (browser.isSafariMobile) classes.push('safari-mobile');
  if (browser.isSafariIOS) classes.push('safari-ios');
  if (browser.isSafari) classes.push('safari');
  
  return classes.join(' ');
};