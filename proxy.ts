import { NextResponse } from 'next/server';

const proxy = () => {
  return NextResponse.next();
};

export default proxy;

export const config = {
  matcher: ['/((?!admin-api|v1|health|_next|.*\\..*).*)'],
};
