"""Small runnable loan application with rules outside its extractable model.

Run directly for an example. Audit both files to see why model extraction alone
cannot preserve borrower checks, checkout limits, or receipt side effects.
"""

from model import Loan


def checkout(record_id, borrower, days, notify=print):
    if not borrower.strip():
        raise ValueError("A borrower is required")
    if not 1 <= days <= 30:
        raise ValueError("Checkout must last between one and thirty days")
    loan = Loan(record_id, borrower, False, days)
    notify(f"Receipt: {borrower} borrowed {record_id} for {days} days")
    return loan


if __name__ == "__main__":
    print(checkout("loan-1", "Asha", 7))
