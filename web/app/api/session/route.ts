import { NextResponse } from 'next/server';
import { OperatorAuthError, requireOperator } from '../../../lib/auth-server';

export async function GET(request: Request) {
  try {
    const { actorId, email, orgId } = await requireOperator(request);
    return NextResponse.json({ actorId, email, orgId }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof OperatorAuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
