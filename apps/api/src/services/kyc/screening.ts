/**
 * Story 73.7: Disposable Domain & Sanctions Blocking
 *
 * Pre-signup screening service that blocks:
 * 1. Disposable/temporary email providers
 * 2. Sanctioned country IPs
 *
 * @module services/kyc/screening
 */

// ============================================
// Disposable Email Domain Blocklist
// ============================================

const DISPOSABLE_DOMAINS = new Set([
  // Popular throwaway email services
  'mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email',
  'yopmail.com', 'guerrillamail.info', 'grr.la', 'guerrillamail.net',
  'guerrillamail.org', 'guerrillamail.de', 'dispostable.com', 'maildrop.cc',
  'mailnesia.com', 'sharklasers.com', 'guerrillamailblock.com', 'trashmail.com',
  'temp-mail.org', 'tmpmail.net', 'tmpmail.org', 'binkmail.com',
  'safetymail.info', 'filzmail.com', 'jetable.org', 'trash-mail.com',
  'mytrashmail.com', 'mailcatch.com', 'trashymail.com', 'getnada.com',
  'mailnator.com', 'tempr.email', 'discard.email', 'discardmail.com',
  'fakeinbox.com', 'mailexpire.com', 'tempail.com', '10minutemail.com',
  'mohmal.com', 'burpcollaborator.net', 'maildax.com', 'tempinbox.com',
  // Additional well-known disposable providers
  'guerrillamail.biz', 'spam4.me', 'spamgourmet.com', 'mytemp.email',
  'harakirimail.com', 'mailtemp.info', 'throwam.com', 'mailzilla.com',
  'tempmailaddress.com', 'emailondeck.com', 'tempmailo.com', 'crazymailing.com',
  'mailnull.com', 'e4ward.com', 'spamfree24.org', 'boun.cr',
  'mailscrap.com', 'getairmail.com', 'tmail.ws', 'blogtrottr.com',
  'armyspy.com', 'cuvox.de', 'dayrep.com', 'einrot.com', 'fleckens.hu',
  'gustr.com', 'jourrapide.com', 'rhyta.com', 'superrito.com', 'teleworm.us',
  'tempmail.de', 'wegwerfmail.de', 'wegwerfmail.net', 'wegwerfmail.org',
  'nada.email', 'nada.ltd', 'anonbox.net', 'anonymbox.com',
  'dontreg.com', 'emailtmp.com', 'fakemailgenerator.com', 'inboxalias.com',
  'instantemailaddress.com', 'jetable.com', 'jetable.net', 'jetable.fr.nf',
  'keepmymail.com', 'klzlk.com', 'lackmail.net', 'letthemeatspam.com',
  'lhsdv.com', 'linuxmail.so', 'lroid.com', 'maileater.com',
  'mailforspam.com', 'mailinator.net', 'mailinator.org', 'mailinator2.com',
  'mailincubator.com', 'mailismagic.com', 'mailme.ir', 'mailme.lv',
  'mailmetrash.com', 'mailmoat.com', 'mailshell.com', 'mailsiphon.com',
  'mailslite.com', 'mailtemporaire.com', 'mailtemporaire.fr', 'mailzilla.org',
  'meltmail.com', 'mintemail.com', 'mt2015.com', 'mytempemail.com',
  'nobulk.com', 'nospamfor.us', 'nowmymail.com', 'objectmail.com',
  'obobbo.com', 'onewaymail.com', 'ourklips.com', 'owlpic.com',
  'pjjkp.com', 'proxymail.eu', 'putthisinyouremail.com', 'quickinbox.com',
  'rcpt.at', 'reallymymail.com', 'receiveee.com', 'regbypass.com',
  'rklips.com', 'rmqkr.net', 'royal.net', 'rppkn.com',
  's0ny.net', 'safe-mail.net', 'safersignup.de', 'safetypost.de',
  'sandelf.de', 'secretemail.de', 'sharklasers.com', 'shieldedmail.com',
  'shiftmail.com', 'skeefmail.com', 'slaskpost.se', 'slipry.net',
  'slopsbox.com', 'smashmail.de', 'soodonims.com', 'spam.la',
  'spamavert.com', 'spambob.com', 'spambob.net', 'spambob.org',
  'spambog.com', 'spambog.de', 'spambog.ru', 'spambox.us',
  'spamcannon.com', 'spamcannon.net', 'spamcero.com', 'spamcon.org',
  'spamcorptastic.com', 'spamcowboy.com', 'spamcowboy.net', 'spamcowboy.org',
  'spamday.com', 'spamex.com', 'spamfighter.cf', 'spamfighter.ga',
  'spamfighter.gq', 'spamfighter.ml', 'spamfighter.tk', 'spamfree.eu',
  'spamherelots.com', 'spamhereplease.com', 'spamhole.com', 'spamify.com',
  'spaminator.de', 'spamkill.info', 'spaml.com', 'spaml.de',
  'spammotel.com', 'spamobox.com', 'spamoff.de', 'spamslicer.com',
  'spamspot.com', 'spamstack.net', 'spamtrail.com', 'spamtrap.ro',
  'speed.1s.fr', 'supergreatmail.com', 'suremail.info', 'teleworm.com',
  'tempalias.com', 'tempe4mail.com', 'tempemail.biz', 'tempemail.co.za',
  'tempemail.com', 'tempemail.net', 'tempinbox.co.uk', 'tempmail.eu',
  'tempmail.it', 'tempmail2.com', 'tempmailer.com', 'tempmailer.de',
  'tempomail.fr', 'temporarily.de', 'temporarioemail.com.br', 'temporaryemail.net',
  'temporaryemail.us', 'temporaryforwarding.com', 'temporaryinbox.com',
  'temporarymailaddress.com', 'thankdog.com', 'thankyou2010.com',
  'thisisnotmyrealemail.com', 'throwawayemailaddress.com', 'tittbit.in',
  'toiea.com', 'tradermail.info', 'trash-amil.com', 'trash-mail.at',
  'trash-mail.cf', 'trash-mail.ga', 'trash-mail.gq', 'trash-mail.ml',
  'trash-mail.tk', 'trash2009.com', 'trash2010.com', 'trash2011.com',
  'trashdevil.com', 'trashdevil.de', 'trashemail.de', 'trashmail.at',
  'trashmail.io', 'trashmail.me', 'trashmail.net', 'trashmail.org',
  'trashmail.ws', 'trashmailer.com', 'trashymail.net', 'turual.com',
  'twinmail.de', 'tyldd.com', 'uggsrock.com', 'upliftnow.com',
  'uplipht.com', 'venompen.com', 'veryreallyfakemail.com', 'viditag.com',
  'viewcastmedia.com', 'viewcastmedia.net', 'viewcastmedia.org',
  'vomoto.com', 'vpn.st', 'vsimcard.com', 'vubby.com',
  'wasteland.rfc822.org', 'webemail.me', 'weg-werf-email.de',
  'wegwerfadresse.de', 'wegwerfemail.com', 'wegwerfemail.de',
  'wegwerfmail.info', 'wh4f.org', 'whatiaas.com', 'whatpaas.com',
  'whyspam.me', 'wilemail.com', 'willhackforfood.biz', 'willselfdestruct.com',
  'winemaven.info', 'wronghead.com', 'wuzup.net', 'wuzupmail.net',
  'wwwnew.eu', 'xagloo.com', 'xemaps.com', 'xents.com',
  'xjoi.com', 'xoxy.net', 'yapped.net', 'yep.it',
  'yogamaven.com', 'yomail.info', 'yopmail.fr', 'yopmail.net',
  'ypmail.webarnak.fr.eu.org', 'yuurok.com', 'zehnminutenmail.de',
  'zippymail.info', 'zoaxe.com', 'zoemail.org',
]);

/**
 * Check if an email address uses a disposable/temporary email provider.
 */
export function isDisposableEmail(email: string): boolean {
  if (!email || !email.includes('@')) return false;
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  return DISPOSABLE_DOMAINS.has(domain);
}

// ============================================
// Sanctioned Countries (OFAC / UN / EU consolidated)
// ============================================

const SANCTIONED_COUNTRIES = new Set([
  'KP', // North Korea
  'IR', // Iran
  'SY', // Syria
  'CU', // Cuba
  'RU', // Russia
  'BY', // Belarus
  'VE', // Venezuela
  'MM', // Myanmar
  'ZW', // Zimbabwe
  'SD', // Sudan
  'SS', // South Sudan
  'CF', // Central African Republic
  'LY', // Libya
  'SO', // Somalia
  'YE', // Yemen
]);

/**
 * Check if a country code is on the sanctions list.
 */
export function isSanctionedCountry(countryCode: string): boolean {
  if (!countryCode) return false;
  return SANCTIONED_COUNTRIES.has(countryCode.toUpperCase());
}

/**
 * Look up the country associated with an IP address.
 *
 * TODO: In production, integrate a real IP geolocation service
 * (e.g., MaxMind GeoIP2, ipinfo.io, or Cloudflare CF-IPCountry header).
 * For now this is a lightweight stub that returns null (unknown).
 */
export async function getCountryFromIP(ip: string): Promise<string | null> {
  if (!ip || ip === 'unknown' || ip === '127.0.0.1' || ip === '::1') {
    return null;
  }

  // TODO: Replace with production geolocation lookup
  // Example with ipinfo.io:
  //   const resp = await fetch(`https://ipinfo.io/${ip}/json?token=${IPINFO_TOKEN}`);
  //   const data = await resp.json();
  //   return data.country || null;

  return null;
}

// ============================================
// Combined Pre-Signup Screening
// ============================================

export interface ScreeningResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Run pre-signup screening checks.
 *
 * 1. Block disposable email domains
 * 2. Block IPs geolocated to sanctioned countries
 */
export async function screenSignup(email: string, ip?: string): Promise<ScreeningResult> {
  // Check disposable email
  if (email && isDisposableEmail(email)) {
    return {
      allowed: false,
      reason: 'Disposable email addresses are not supported',
    };
  }

  // Check IP-based sanctions
  if (ip) {
    const country = await getCountryFromIP(ip);
    if (country && isSanctionedCountry(country)) {
      return {
        allowed: false,
        reason: 'Service is not available in your region',
      };
    }
  }

  return { allowed: true };
}

/**
 * Validate a country code directly (used for form-submitted country fields).
 */
export function screenCountry(countryCode: string): ScreeningResult {
  if (isSanctionedCountry(countryCode)) {
    return {
      allowed: false,
      reason: 'Service is not available in your region',
    };
  }
  return { allowed: true };
}
